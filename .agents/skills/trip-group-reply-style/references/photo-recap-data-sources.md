# Photo recap data sources and fallback workflow

Use this when drafting the family group's daily photo recap and the trip-site MCP photo output is too large, lacks visual detail, or gives filenames only.

## Reliable fallback chain

1. Use the trip site MCP photos feed first to count recent uploads (~24h), active phase, and uploaders.
2. If you need visual/detail grounding, fetch the phase's public Immich share URL from the trip site endpoint:
   - `GET https://ara-united.store/api/album-share/<phase>`
3. Resolve album metadata from Immich:
   - `GET https://photos.elulhome.com/api/shared-links/me?key=<shareKey>`
   - This returns album id, album name, asset count, and updatedAt.
4. Pull recent asset buckets for the shared album:
   - `GET https://photos.elulhome.com/api/timeline/buckets?key=<shareKey>&albumId=<albumId>`
   - `GET https://photos.elulhome.com/api/timeline/bucket?key=<shareKey>&albumId=<albumId>&timeBucket=<YYYY-MM-01>`
5. Use the bucket data to extract concrete-but-safe recap details:
   - recent `fileCreatedAt`
   - city clusters (for example Vail / Breckenridge / Blue River / Frisco)
   - upload bursts / density by time
6. For 1-3 concrete highlights, open a few public Immich thumbnails with vision using:
   - `https://photos.elulhome.com/api/assets/<assetId>/thumbnail?key=<shareKey>`
   - Do **not** use the trip site's `/api/photos/file/...` URLs for vision unless you also have valid auth; they can return 401.

## Message-shaping guidance

- If vision only gives partial scene understanding, prefer grounded highlights like:
  - lakeside / mountain views
  - village stroll in Vail or Breckenridge
  - cozy cabin / house views
- Avoid inventing specific activities when the image only proves scenery or walking around town.
- If recent uploads are real but visual specifics stay thin, it is still better to mention 1-2 verified scene-level highlights than to send a generic "new photos are up" message.
- If even those specifics are not reliable, use a **real upload-pattern highlight** instead:
  - one uploader added a large burst of photos
  - several family members added to the same phase album
  - the current phase album got a substantial refresh in the last day
- Keep those phrased as social/photo highlights, not as guessed activities.

## Why this matters

The family group's recap should feel specific and fresh, but still be verifiable from actual photo/album data rather than guessed from filenames.