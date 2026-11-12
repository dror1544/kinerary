/**
 * Photos and albums for the Telegram stand-in (tools/fake-telegram.ts), as pure
 * functions so a test can read exactly what the relay would be handed without
 * starting a server.
 *
 * What a person does that this models: they pick two pictures and send them
 * together. Telegram delivers that as TWO messages, not one, linked only by a
 * shared `media_group_id`; each carries a `photo` array of sizes (smallest
 * first, largest last — normalize.ts's describeAttachment takes the last), and
 * the caption, if any, rides on one of them. The relay then has to fetch each
 * size's bytes through getFile and the /file/ route, which fake-telegram.ts
 * serves from the files this module returns.
 */

export interface AlbumPhoto {
  bytes: Buffer;
  width?: number;
  height?: number;
}

export interface StoredFile {
  id: string;
  path: string;
  bytes: Buffer;
  mime: string;
  name: string;
}

export interface Album {
  /** One Telegram `message` per photo, in send order, sharing one `media_group_id` when there is one. */
  messages: Record<string, unknown>[];
  /** Every file the messages name, for getFile and the /file/ download. */
  files: StoredFile[];
}

/**
 * The smaller size Telegram would ALSO list for a photo. Same picture, different
 * bytes: a trailing marker after the JPEG's end-of-image is ignored by every
 * decoder but changes the digest, so a consumer that stores the wrong size (the
 * first array entry rather than the last) is caught by comparing the stored
 * file with what was sent, instead of passing by luck because the two matched.
 */
export function thumbnailOf(bytes: Buffer): Buffer {
  return Buffer.concat([bytes, Buffer.from("\n#thumb\n")]);
}

export interface AlbumOptions {
  photos: AlbumPhoto[];
  /** Fields every message shares: `chat`, `from`, `date`. `message_id` is set here, per photo. */
  base: Record<string, unknown>;
  firstMessageId: number;
  /** Absent for a single photo sent alone. */
  mediaGroupId?: string;
  /** Telegram puts one caption on one message of an album; it goes on the first. */
  caption?: string;
  newFileId: () => string;
  mime?: string;
}

export function buildAlbum(options: AlbumOptions): Album {
  const { photos, base, firstMessageId, mediaGroupId, caption, newFileId } = options;
  const mime = options.mime ?? "image/jpeg";
  const files: StoredFile[] = [];
  const messages = photos.map((photo, index) => {
    const small = newFileId();
    const large = newFileId();
    const width = photo.width ?? 1280;
    const height = photo.height ?? 960;
    const thumb = thumbnailOf(photo.bytes);
    files.push(
      { id: small, path: `photos/${small}.jpg`, bytes: thumb, mime, name: `${small}.jpg` },
      { id: large, path: `photos/${large}.jpg`, bytes: photo.bytes, mime, name: `${large}.jpg` },
    );
    return {
      ...base,
      message_id: firstMessageId + index,
      ...(mediaGroupId ? { media_group_id: mediaGroupId } : {}),
      photo: [
        { file_id: small, file_unique_id: small, file_size: thumb.length, width: Math.round(width / 4), height: Math.round(height / 4) },
        { file_id: large, file_unique_id: large, file_size: photo.bytes.length, width, height },
      ],
      ...(caption && index === 0 ? { caption } : {}),
    };
  });
  return { messages, files };
}
