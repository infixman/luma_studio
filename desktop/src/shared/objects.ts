/**
 * Turning a folder of encoded output into the keys the server will sign.
 *
 * The shapes below mirror `video.allowed_object` in the backend. **That list is
 * the authority** — it decides what may be written, and this one exists only so
 * the tool can say "that folder has a file the pipeline does not produce" before
 * spending a round trip per object. A disagreement between them shows up as a
 * refused presign, which is the right way round: the copy that can be wrong is
 * the one that fails safe.
 */

export const RENDITIONS = ['1080p', '720p', '480p'] as const

const SHAPES = [
  /^master\.m3u8$/,
  /^poster\.webp$/,
  new RegExp(`^(?:${RENDITIONS.join('|')})/playlist\\.m3u8$`),
  new RegExp(`^(?:${RENDITIONS.join('|')})/init\\.mp4$`),
  new RegExp(`^(?:${RENDITIONS.join('|')})/segment-\\d{6}\\.m4s$`),
]

/**
 * Content types, because a playlist served as octet-stream is a playlist no
 * player will read. R2 keeps whatever is sent with the PUT, so this is the only
 * chance to get it right.
 */
const CONTENT_TYPES: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.webp': 'image/webp',
}

export function contentTypeFor(name: string): string {
  const dot = name.lastIndexOf('.')
  const suffix = dot === -1 ? '' : name.slice(dot).toLowerCase()
  // Not `application/octet-stream` as a fallback that quietly works: a file
  // whose type is unknown here is a file that is not part of an encode, and
  // `isEncodeObject` will have refused it already.
  return CONTENT_TYPES[suffix] ?? 'application/octet-stream'
}

/** Slashes both ways, because this comes from a Windows directory walk. */
export function toPosix(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
}

export function isEncodeObject(relativePath: string): boolean {
  const path = toPosix(relativePath)
  return SHAPES.some((shape) => shape.test(path))
}

export function objectKey(assetId: string, encodeVersion: number, relativePath: string): string {
  return `videos/${assetId}/${encodeVersion}/${toPosix(relativePath)}`
}

/**
 * The order to upload in, and it is not cosmetic.
 *
 * `master.m3u8` goes last. Registration starts by reading it, so an upload that
 * stopped halfway has no master and is refused with "the master is missing" —
 * one sentence somebody can act on. Uploaded first, the same interruption is
 * refused with a list of three hundred absent segments, which is the same fact
 * told uselessly.
 *
 * Everything else is sorted so a run is reproducible and a resumed one picks up
 * where the last stopped rather than somewhere arbitrary.
 */
export function uploadOrder(relativePaths: readonly string[]): string[] {
  const paths = relativePaths.map(toPosix)
  const master = paths.filter((path) => path === 'master.m3u8')
  const rest = paths.filter((path) => path !== 'master.m3u8').sort()
  return [...rest, ...master]
}

export function batched<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error('batch size must be at least 1')
  const out: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size))
  }
  return out
}

/** What the server will hand out in one request. Mirrors `video_storage.MAX_URLS`. */
export const URL_BATCH = 100
