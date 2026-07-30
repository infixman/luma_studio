import { createHash } from 'node:crypto'

/**
 * A stable name for "this folder's upload", so a resumed run finds its own
 * ledger — and a *different* name once the folder's contents change.
 *
 * The size and file count go into it, not just the path. Re-encoding into the
 * same folder produces the same relative paths, so a ledger keyed on the path
 * alone would resume against the old asset and skip uploading files that had
 * changed. Nothing would report an error; the video would simply be the old one.
 *
 * Not a hash of the files themselves: reading several hundred of them to decide
 * whether to resume costs more than the re-uploads it would save, and size plus
 * count catches every re-encode that is not a coincidence.
 */
export function jobId(folder: string, objects: number, totalBytes: number): string {
  return createHash('sha256')
    // Separators normalised, and the path lowercased. `C:\encodes\a` and
    // `C:/encodes/a` are one folder on Windows and so are `C:\Encodes\A`, but
    // three different strings — and three different ledgers, which presents as
    // the same folder uploading itself again under a new asset id. Seen: passing
    // a forward-slash path to the same encode produced a second asset and
    // fourteen re-uploads.
    .update(`${folder.replace(/\\/g, '/').toLowerCase()}\0${objects}\0${totalBytes}`)
    .digest('hex')
    .slice(0, 16)
}
