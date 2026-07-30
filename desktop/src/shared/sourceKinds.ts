/**
 * Telling a video file from a folder of finished output.
 *
 * In `shared` because both the interface and the main process ask the question,
 * and two lists of extensions would be one commit away from disagreeing.
 *
 * By extension, which is a hint rather than an answer — ffprobe decides whether
 * the file is really a video. That is the right order: guessing here only picks
 * which path to try, and the path itself refuses properly.
 */

export const SOURCE_EXTENSIONS = ['.mp4', '.mov', '.mkv', '.m4v'] as const

export function looksLikeSource(path: string): boolean {
  const dot = path.lastIndexOf('.')
  if (dot === -1) return false
  return (SOURCE_EXTENSIONS as readonly string[]).includes(path.slice(dot).toLowerCase())
}
