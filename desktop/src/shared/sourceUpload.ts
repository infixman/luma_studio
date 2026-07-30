/**
 * Cutting the original file into the parts the server asked for.
 *
 * The HLS objects are hundreds of separate files, so uploading them is a loop
 * over names. The original is one file of several gigabytes and goes up as a
 * multipart upload, which means the tool has to decide which bytes are part 3 —
 * and get the same answer the server did, because the server computed the part
 * size from the size this tool reported.
 *
 * Pure on purpose. Reading the bytes and sending them needs the filesystem and
 * the network; deciding what to send does not, and this is the half that can be
 * wrong in a way nothing notices until the upload is finished.
 */

export interface PartRange {
  partNumber: number
  /** Inclusive. */
  start: number
  /** Exclusive, so `end - start` is the length. */
  end: number
}

export function partRanges(byteSize: number, partSize: number): PartRange[] {
  if (!Number.isSafeInteger(byteSize) || byteSize <= 0) {
    throw new Error('檔案大小必須是正整數')
  }
  if (!Number.isSafeInteger(partSize) || partSize <= 0) {
    throw new Error('分段大小必須是正整數')
  }

  const ranges: PartRange[] = []
  for (let start = 0; start < byteSize; start += partSize) {
    ranges.push({
      partNumber: ranges.length + 1,
      start,
      // The last part is whatever is left, and it is the only one allowed to be
      // shorter — S3 refuses a short part anywhere else, at the end of the
      // upload rather than at the start of it.
      end: Math.min(start + partSize, byteSize),
    })
  }
  return ranges
}

/**
 * The ETag R2 returned for a part, which is what completing the upload is made
 * of.
 *
 * Missing is fatal and has to be noticed here. A part whose tag was not read is
 * a part that cannot be named at the end, and the upload would fail after every
 * byte had been sent — the most expensive place to find out.
 *
 * It throws a plain `Error` rather than an `AdminApiError`, which matters to the
 * caller: `isTransient` classifies by status code and this has none. Re-sending
 * the part is the right response, so a retry loop has to treat this case as
 * retryable itself rather than inferring it.
 */
export function etagOf(headers: { get(name: string): string | null }, partNumber: number): string {
  const etag = (headers.get('etag') ?? headers.get('ETag') ?? '').trim()
  if (!etag) {
    throw new Error(`分段 ${partNumber} 上傳後沒有拿到 ETag，無法完成合併`)
  }
  return etag
}

/**
 * Which parts still need sending.
 *
 * A resumed upload knows the parts it already finished. The session cannot be
 * resumed across restarts today — the upload id lives only in the server's row
 * and the tool does not keep the session id — so this exists for the retry
 * inside one run, where re-sending a gigabyte that already landed is the
 * difference between a retry and starting again.
 */
export function remaining(ranges: readonly PartRange[], done: ReadonlySet<number>): PartRange[] {
  return ranges.filter((range) => !done.has(range.partNumber))
}
