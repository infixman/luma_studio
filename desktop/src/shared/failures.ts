/**
 * Turning what went wrong into a sentence somebody can act on.
 *
 * Node's errors are written for whoever wrote the syscall: `ENOTDIR: not a
 * directory, scandir 'C:\...\car_h64.png'` names the errno, the operation and
 * the path, and leaves out the only thing the person holding the mouse needed to
 * know — that a PNG is not something this tool uploads.
 *
 * In `shared` because the main process is where errors happen and the interface
 * is where they are read, and the sentences should not depend on which side
 * happened to catch it.
 */

import { SOURCE_EXTENSIONS } from './sourceKinds'

/**
 * Just the last segment. A full Windows path is most of a sentence on its own,
 * and the end of it is the part somebody recognises.
 *
 * Both separators, because these paths come from Windows and are written with
 * either depending on who produced them.
 */
export function lastSegment(path: string | undefined): string {
  if (!path) return '這個項目'
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

const DROPPABLE = SOURCE_EXTENSIONS.join('、')

function sentenceFor(code: string, path: string | undefined, original: string): string | null {
  const it = lastSegment(path)
  switch (code) {
    case 'ENOTDIR':
      // The one that started this. Reached by dropping a file the tool does not
      // recognise as a video: it is not a source, so it is tried as a folder of
      // finished output, and it is not that either.
      return `「${it}」是一個檔案，不是資料夾。可以拖一支影片（${DROPPABLE}）進來轉檔，或拖一個已經轉好的資料夾。`
    case 'ENOENT':
      return `找不到「${it}」。它可能已經被移動、改名或刪除了。`
    case 'EACCES':
    case 'EPERM':
      return `沒有權限讀取「${it}」。如果它在別人的使用者資料夾或受保護的位置，先複製到自己的資料夾再試。`
    case 'EBUSY':
      return `「${it}」正在被其他程式使用。關掉開著它的程式再試一次。`
    case 'ENOSPC':
      return '磁碟空間不足。轉檔會產生比原始影片更多的檔案，需要幾 GB 的可用空間。'
    case 'EISDIR':
      return `「${it}」是一個資料夾，這裡需要的是一個檔案。`
    default:
      // Unrecognised, so the original text stays. Replacing it with a generic
      // sentence would trade one unreadable message for an unreadable message
      // with nothing left to search for.
      return original ? `讀取「${it}」時發生問題：${original}` : null
  }
}

/**
 * What to show for `error`.
 *
 * An `Error` with no `code` is left alone: everything this tool raises
 * deliberately — a cancellation, a server's refusal, a missing FFmpeg — arrives
 * here too, and those sentences were written on purpose.
 */
export function explain(error: unknown, { path }: { path?: string }): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string') {
      const said = sentenceFor(code, path, error.message)
      if (said) return said
    }
    if (error.message) return error.message
  }
  if (typeof error === 'string' && error) return error
  return path ? `無法處理「${lastSegment(path)}」。` : '發生未預期的問題。'
}
