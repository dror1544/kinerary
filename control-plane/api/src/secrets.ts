import { readFile } from "node:fs/promises";

/**
 * Resolves an opaque secret reference validated by config.ts's
 * `secretReference` schema (env://, file://, vault://) into its actual
 * value. This is the one place those three schemes get dereferenced — every
 * caller passes an already-schema-validated string, so an unrecognized
 * scheme here means the schema and resolver have drifted, not bad input.
 *
 * vault:// is accepted by the schema (and by canonical.ts's opaque-reference
 * check) but has no resolver: no Vault client exists anywhere in this
 * codebase yet. Resolving one throws a clear "not implemented" error rather
 * than silently returning something wrong.
 */
export async function resolveSecretRef(ref: string): Promise<string> {
  if (ref.startsWith("env://")) {
    const name = ref.slice("env://".length);
    const value = process.env[name];
    if (!value) {
      throw new Error(`secret reference env://${name} is unset or empty`);
    }
    return value;
  }
  if (ref.startsWith("file://")) {
    const path = ref.slice("file://".length);
    const value = (await readFile(path, "utf8")).trim();
    if (!value) {
      throw new Error(`secret reference file://${path} is empty`);
    }
    return value;
  }
  if (ref.startsWith("vault://")) {
    throw new Error(`secret reference ${ref} uses the vault:// scheme, which has no resolver implementation yet`);
  }
  throw new Error(`secret reference has an unrecognized scheme: ${ref}`);
}
