/**
 * A size, in the unit a reader can act on.
 *
 * One function for the whole back office, because the media library, the ibon
 * uploader and the video library all describe the same kind of number — and the
 * moment two of them describe it differently, "is this the same file" becomes a
 * conversion exercise.
 *
 * It started in `mediaFacts` and stopped at megabytes, which is the top of the
 * range for an image. A course video is a few gigabytes, and `2048.0 MB` is a
 * number the reader has to convert before it means anything.
 */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}
