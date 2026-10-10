/**
 * Where an uploaded document's original bytes live.
 *
 * Until now they lived nowhere. The relay re-hosts a Telegram attachment in
 * memory for an hour so the poller can read it, and then it is gone — so a trip
 * reconstructed from four confirmations could not show anyone the voucher
 * behind a hotel, and could not re-read a document when the extractor got
 * better. The registry (0052) records WHAT a document is; this module keeps the
 * bytes that record points at.
 *
 * CONTENT-ADDRESSED AND WRITE-ONCE. A document is stored at
 * `<root>/<trip_id>/<sha256-hex>.<ext>`. Nothing about that path comes from the
 * uploader: the trip id is ours and validated, the name is the digest of the
 * bytes, and the extension is chosen from a fixed list by the reader's own
 * classification. An uploader's filename is metadata on the delivery row and
 * never a path component, because a filename that becomes a path is a
 * traversal waiting for someone to name a file `../../server-data/app.db`.
 *
 * WHY `link()` AND NOT `rename()`. The ordinary atomic-write pattern is "write a
 * temp file, rename it into place". Rename REPLACES an existing target, which is
 * wrong here twice over: two concurrent uploads of the same voucher would race
 * to overwrite each other, and a bug that computed the wrong name would
 * silently clobber a different document. `link(temp, final)` is equally atomic
 * — including on NFS, where it is the classic lock-file primitive — and fails
 * with EEXIST instead of replacing. So concurrent identical uploads converge on
 * one file, and the loser simply verifies that what is already there is what it
 * meant to write.
 *
 * Postgres and the filesystem cannot share a transaction. The registry row's
 * `reserved -> stored` states are the recovery record for that gap; this module
 * guarantees only that any file at a final path is complete and matches its
 * name, which is what makes an orphan safe to delete and a reserved row safe to
 * retry.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
import { constants as fsConstants } from "node:fs";
import { copyFile, link, mkdir, open, readdir, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";

/** The extensions a stored original may carry, keyed by the reader's own kind. */
// The image kinds are what the vision reader accepts (document-vision.ts). SVG is
// deliberately absent: it is a script-capable document, not a picture.
export type DocumentExtension = "pdf" | "docx" | "xlsx" | "html" | "txt" | "png" | "jpg" | "webp" | "gif";

const TRIP_ID = /^[a-z]{2,12}_[A-Za-z0-9]{8,64}$/;
const DIGEST = /^sha256:([a-f0-9]{64})$/;
const STORAGE_KEY = /^([a-z]{2,12}_[A-Za-z0-9]{8,64})\/([a-f0-9]{64})\.(pdf|docx|xlsx|html|txt|png|jpg|webp|gif)$/;
const TEMP_SUFFIX = ".tmp";

export type DocumentStoreErrorCode =
  | "INVALID_KEY"
  | "DIGEST_MISMATCH"
  | "CONFLICTING_CONTENT"
  | "INVALID_DESTINATION";

export class DocumentStoreError extends Error {
  constructor(readonly code: DocumentStoreErrorCode, message: string) {
    super(message);
    this.name = "DocumentStoreError";
  }
}

/** `sha256:<hex>` of the bytes — the one digest shape the schema accepts. */
export function contentDigest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** The reader's document kind, as a file extension. */
export function documentExtensionFor(kind: "pdf" | "docx" | "xlsx" | "html" | "text"): DocumentExtension {
  return kind === "text" ? "txt" : kind;
}

/**
 * The storage key for a document. Throws rather than returning something
 * plausible: a malformed key reaching the filesystem is the failure this whole
 * module exists to make impossible.
 */
export function storageKeyFor(tripId: string, digest: string, ext: DocumentExtension): string {
  if (!TRIP_ID.test(tripId)) throw new DocumentStoreError("INVALID_KEY", "trip id is not an opaque id");
  const hex = DIGEST.exec(digest)?.[1];
  if (!hex) throw new DocumentStoreError("INVALID_KEY", "digest is not sha256:<hex>");
  const key = `${tripId}/${hex}.${ext}`;
  if (!STORAGE_KEY.test(key)) throw new DocumentStoreError("INVALID_KEY", "unsupported extension");
  return key;
}

export function parseStorageKey(key: string): { tripId: string; digest: string; ext: DocumentExtension } | null {
  const match = STORAGE_KEY.exec(key);
  if (!match) return null;
  return { tripId: match[1]!, digest: `sha256:${match[2]!}`, ext: match[3] as DocumentExtension };
}

/**
 * How a stored original reached a trip's own document area.
 *
 *   hardlink  one set of bytes on disk, two names — the preferred case, when the
 *             control-plane store and the trip's directory share a filesystem
 *   copy      a verified copy, when they do not (EXDEV) or links are refused
 *   existing  the trip already had it — a retried handoff, byte-identical
 */
export type PublishStrategy = "hardlink" | "copy" | "existing";

export interface DocumentBlobStore {
  /** Store bytes at `key`. `created: false` means identical bytes were already there. */
  put(key: string, bytes: Uint8Array): Promise<{ created: boolean }>;
  read(key: string): Promise<Uint8Array | null>;
  exists(key: string): Promise<boolean>;
  /** Every final key stored for one trip. Temporary files are not keys. */
  list(tripId: string): Promise<string[]>;
  /**
   * Make a stored original available under `destinationDir` without moving it.
   * The published name is the same content-addressed `<hex>.<ext>`.
   */
  publish(key: string, destinationDir: string): Promise<{ strategy: PublishStrategy; path: string }>;
  /** Delete one original. Only the registry decides when that is allowed. */
  remove(key: string): Promise<boolean>;
  /** Delete interrupted writes older than `olderThanMs`. Returns how many. */
  sweepTemporary(olderThanMs: number, now?: number): Promise<number>;
}

/** Filesystem operations the store needs, injectable so tests can force a fallback. */
export interface StoreFs {
  link: (existingPath: string, newPath: string) => Promise<void>;
}

function errno(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | undefined)?.code;
}

async function digestOfFile(filePath: string): Promise<string | null> {
  try {
    return contentDigest(await readFile(filePath));
  } catch (e) {
    if (errno(e) === "ENOENT") return null;
    throw e;
  }
}

/** Write bytes to a fresh temporary file beside `finalPath`, flushed to disk. */
async function writeTemp(finalPath: string, bytes: Uint8Array): Promise<string> {
  const temp = path.join(
    path.dirname(finalPath),
    `.${path.basename(finalPath)}.${randomBytes(8).toString("hex")}${TEMP_SUFFIX}`,
  );
  // `wx`: a temp name that somehow already exists is refused, never reused.
  const handle = await open(temp, "wx", 0o640);
  try {
    await handle.writeFile(bytes);
    // Flushed before it is linked into place. On NFS a close without a sync can
    // report success for data the server never committed, and the whole point of
    // a final path is that it is complete.
    await handle.datasync();
  } finally {
    await handle.close();
  }
  return temp;
}

/**
 * A store rooted at a directory — NFS in production, a temp directory in tests.
 * The code does not know or care which; that is deployment configuration.
 */
export function filesystemDocumentStore(root: string, fsOps: Partial<StoreFs> = {}): DocumentBlobStore {
  if (!path.isAbsolute(root)) throw new DocumentStoreError("INVALID_DESTINATION", "document root must be absolute");
  const linkFile = fsOps.link ?? link;

  const pathFor = (key: string): string => {
    const parsed = parseStorageKey(key);
    if (!parsed) throw new DocumentStoreError("INVALID_KEY", "not a storage key");
    return path.join(root, key);
  };

  /** An existing final path is acceptable only if it holds exactly these bytes. */
  const confirmIdentical = async (finalPath: string, expected: string): Promise<void> => {
    const actual = await digestOfFile(finalPath);
    if (actual !== expected) {
      throw new DocumentStoreError(
        "CONFLICTING_CONTENT",
        "a stored document does not match its content-addressed name",
      );
    }
  };

  return {
    async put(key, bytes) {
      const finalPath = pathFor(key);
      const expected = parseStorageKey(key)!.digest;
      if (contentDigest(bytes) !== expected) {
        throw new DocumentStoreError("DIGEST_MISMATCH", "bytes do not match the storage key");
      }
      await mkdir(path.dirname(finalPath), { recursive: true, mode: 0o750 });

      // Already stored — the ordinary re-upload. Verified rather than trusted.
      if ((await digestOfFile(finalPath)) === expected) return { created: false };

      const temp = await writeTemp(finalPath, bytes);
      try {
        const written: Stats = await stat(temp);
        if (written.size !== bytes.byteLength || (await digestOfFile(temp)) !== expected) {
          throw new DocumentStoreError("DIGEST_MISMATCH", "written bytes failed verification");
        }
        try {
          await linkFile(temp, finalPath);
          return { created: true };
        } catch (e) {
          const code = errno(e);
          if (code === "EEXIST") {
            // Lost a race to an identical upload — or found a stale, corrupt
            // file. The first is success; the second must not be papered over.
            await confirmIdentical(finalPath, expected);
            return { created: false };
          }
          if (code === "EPERM" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EMLINK") {
            // A filesystem that refuses hard links. COPYFILE_EXCL keeps the
            // no-replace guarantee, though not atomicity — a concurrent reader
            // could see a partial file, which is why readers go through the
            // registry's `stored` state rather than probing paths.
            try {
              await copyFile(temp, finalPath, fsConstants.COPYFILE_EXCL);
              return { created: true };
            } catch (copyError) {
              if (errno(copyError) !== "EEXIST") throw copyError;
              await confirmIdentical(finalPath, expected);
              return { created: false };
            }
          }
          throw e;
        }
      } finally {
        await unlink(temp).catch(() => {});
      }
    },

    async read(key) {
      try {
        return new Uint8Array(await readFile(pathFor(key)));
      } catch (e) {
        if (errno(e) === "ENOENT") return null;
        throw e;
      }
    },

    async exists(key) {
      try {
        await stat(pathFor(key));
        return true;
      } catch (e) {
        if (errno(e) === "ENOENT") return false;
        throw e;
      }
    },

    async list(tripId) {
      if (!TRIP_ID.test(tripId)) throw new DocumentStoreError("INVALID_KEY", "trip id is not an opaque id");
      let names: string[];
      try {
        names = await readdir(path.join(root, tripId));
      } catch (e) {
        if (errno(e) === "ENOENT") return [];
        throw e;
      }
      return names
        .map((name) => `${tripId}/${name}`)
        .filter((key) => parseStorageKey(key) !== null)
        .sort();
    },

    async publish(key, destinationDir) {
      const source = pathFor(key);
      const expected = parseStorageKey(key)!.digest;
      if (!path.isAbsolute(destinationDir)) {
        throw new DocumentStoreError("INVALID_DESTINATION", "destination must be absolute");
      }
      const destination = path.join(destinationDir, path.basename(source));
      await mkdir(destinationDir, { recursive: true, mode: 0o750 });

      try {
        await linkFile(source, destination);
        return { strategy: "hardlink", path: destination };
      } catch (e) {
        const code = errno(e);
        if (code === "EEXIST") {
          await confirmIdentical(destination, expected);
          return { strategy: "existing", path: destination };
        }
        if (code !== "EXDEV" && code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "EMLINK") {
          throw e;
        }
      }

      // Separate filesystems, or links refused: a verified copy, finalised with
      // the same no-replace link as `put` so a retried handoff converges.
      const bytes = await readFile(source);
      if (contentDigest(bytes) !== expected) {
        throw new DocumentStoreError("CONFLICTING_CONTENT", "stored original failed verification before copy");
      }
      const temp = await writeTemp(destination, bytes);
      try {
        try {
          await link(temp, destination);
        } catch (e) {
          if (errno(e) === "EEXIST") {
            await confirmIdentical(destination, expected);
            return { strategy: "existing", path: destination };
          }
          if (errno(e) !== "EPERM" && errno(e) !== "ENOTSUP" && errno(e) !== "EOPNOTSUPP") throw e;
          try {
            await copyFile(temp, destination, fsConstants.COPYFILE_EXCL);
          } catch (copyError) {
            if (errno(copyError) !== "EEXIST") throw copyError;
            await confirmIdentical(destination, expected);
            return { strategy: "existing", path: destination };
          }
        }
        return { strategy: "copy", path: destination };
      } finally {
        await unlink(temp).catch(() => {});
      }
    },

    async remove(key) {
      try {
        await unlink(pathFor(key));
        return true;
      } catch (e) {
        if (errno(e) === "ENOENT") return false;
        throw e;
      }
    },

    async sweepTemporary(olderThanMs, now = Date.now()) {
      let trips: string[];
      try {
        trips = await readdir(root);
      } catch (e) {
        if (errno(e) === "ENOENT") return 0;
        throw e;
      }
      let removed = 0;
      for (const trip of trips) {
        if (!TRIP_ID.test(trip)) continue;
        const dir = path.join(root, trip);
        let names: string[];
        try {
          names = await readdir(dir);
        } catch {
          continue;
        }
        for (const name of names) {
          if (!name.startsWith(".") || !name.endsWith(TEMP_SUFFIX)) continue;
          const full = path.join(dir, name);
          try {
            const info = await stat(full);
            if (now - info.mtimeMs >= olderThanMs) {
              await unlink(full);
              removed += 1;
            }
          } catch {
            // Gone already — another sweeper, or the write finished.
          }
        }
      }
      return removed;
    },
  };
}

/**
 * The configured store, or undefined when none is configured.
 *
 * Unset is a supported state, not an error — exactly like an unset model
 * runner. A relay with no store still reads documents; it just cannot keep
 * them, and says so in its log rather than pretending it did.
 */
/** A file an operator creates once, on the persistent volume, to say "this is the store". */
export const DOCUMENT_STORE_MARKER = ".kinerary-document-store";

export type DocumentStoreReadiness =
  | { ok: true; root: string }
  | {
      ok: false;
      reason: "NOT_CONFIGURED" | "MISSING" | "NOT_A_DIRECTORY" | "NO_MARKER" | "NOT_WRITABLE" | "NOT_A_MOUNT";
      detail: string;
    };

/**
 * The mount point a path lives on, from `/proc/self/mountinfo` text. Mount
 * points there escape spaces and friends as octal (`\040`).
 */
export function mountPointFor(target: string, mountinfo: string): string | null {
  let best: string | null = null;
  for (const line of mountinfo.split("\n")) {
    const raw = line.split(" ")[4];
    if (!raw) continue;
    const point = raw.replace(/\\(\d{3})/g, (_, oct: string) => String.fromCharCode(parseInt(oct, 8)));
    const inside = point === "/" || target === point || target.startsWith(point.endsWith("/") ? point : `${point}/`);
    if (inside && (best === null || point.length > best.length)) best = point;
  }
  return best;
}

/**
 * Whether the configured document store is the persistent volume it has to be.
 *
 * Originals are the one thing here that cannot be rebuilt: an intake version
 * references them by digest, and the organizer may never send them again. So a
 * deployment that REQUIRES the store (`DOCUMENT_STORE_REQUIRED=1`, which
 * compose.vm.yml sets) must refuse to start rather than write them somewhere a
 * container recreate erases. Checked, in order:
 *
 *  - it is configured, exists, and is a directory;
 *  - it carries DOCUMENT_STORE_MARKER — created once on the real volume, so an
 *    empty directory Docker made because the mount was missing fails here;
 *  - a file can be written and removed;
 *  - on Linux, the directory is on a mount of its own, not the container's
 *    root filesystem.
 */
export async function checkDocumentStore(
  env: NodeJS.ProcessEnv = process.env,
  probe: { mountinfo?: () => Promise<string | null> } = {},
): Promise<DocumentStoreReadiness> {
  const configured = (env.DOCUMENT_STORE_DIR ?? "").trim();
  if (!configured) return { ok: false, reason: "NOT_CONFIGURED", detail: "DOCUMENT_STORE_DIR is not set" };
  const root = path.resolve(configured);
  let info: Stats;
  try {
    info = await stat(root);
  } catch {
    return { ok: false, reason: "MISSING", detail: `${root} does not exist` };
  }
  if (!info.isDirectory()) return { ok: false, reason: "NOT_A_DIRECTORY", detail: `${root} is not a directory` };
  try {
    await stat(path.join(root, DOCUMENT_STORE_MARKER));
  } catch {
    return {
      ok: false,
      reason: "NO_MARKER",
      detail: `${root}/${DOCUMENT_STORE_MARKER} is missing — the persistent volume is not mounted here, or was never initialised`,
    };
  }
  const probeFile = path.join(root, `.write-probe-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    const handle = await open(probeFile, "wx");
    await handle.close();
    await unlink(probeFile);
  } catch (error) {
    return { ok: false, reason: "NOT_WRITABLE", detail: `${root}: ${(error as NodeJS.ErrnoException).code ?? "cannot write"}` };
  }
  const mountinfo = probe.mountinfo
    ? await probe.mountinfo()
    : await readFile("/proc/self/mountinfo", "utf8").catch(() => null);
  if (mountinfo !== null) {
    const point = mountPointFor(root, mountinfo);
    if (point === "/") {
      return { ok: false, reason: "NOT_A_MOUNT", detail: `${root} is on the container's own filesystem, not a mounted volume` };
    }
  }
  return { ok: true, root };
}

export function documentStoreFromEnv(env: NodeJS.ProcessEnv = process.env): DocumentBlobStore | undefined {
  const root = (env.DOCUMENT_STORE_DIR ?? "").trim();
  if (!root) return undefined;
  return filesystemDocumentStore(path.resolve(root));
}
