import { open } from 'node:fs/promises'

import {
  AdminApiError,
  abortSourceUpload,
  completeSourceUpload,
  isTransient,
  sourcePartUrl,
  startSourceUpload,
} from '../shared/adminApi'
import { withRetry, DEFAULT_ATTEMPTS } from '../shared/retry'
import { Cancelled, isCancelled } from './transcoder'
import { etagOf, partRanges } from '../shared/sourceUpload'
import type { Progress } from '../shared/upload'
import type { Transport } from '../shared/adminApi'

/**
 * Sending the original file, in parts.
 *
 * Unlike the encode's hundreds of small objects, this is one object of several
 * gigabytes and R2 holds the upload open until something ends it. Two rules come
 * out of that and both are here rather than in the pure layer, because they are
 * about when to make a request:
 *
 * A part's URL is asked for immediately before that part is sent. They live
 * fifteen minutes, and while a part is only five megabytes today, a batch of
 * four thousand of them taken up front would have expired long before the last
 * one was reached.
 *
 * A failure cancels the session on the way out. Parts already sent are billed
 * and invisible in a bucket listing, and the server refuses to open a second
 * session for an asset while one is live, so leaving it is both a cost and a
 * door locked behind us.
 */

export interface SourceUploadOptions {
  transport: Transport
  base: string
  token: string
  assetId: string
  /** The file that was dropped in. */
  path: string
  onProgress: (progress: Progress) => void
}

async function putPart(url: string, body: Uint8Array, partNumber: number): Promise<string> {
  const response = await fetch(url, { method: 'PUT', body })
  if (!response.ok) {
    // The status, never the URL. Errors get pasted into chats.
    throw new AdminApiError(response.status, `分段上傳失敗（HTTP ${response.status}）`)
  }
  return etagOf(response.headers, partNumber)
}

export async function uploadSource(options: SourceUploadOptions): Promise<string> {
  const { transport, base, token, assetId, path, onProgress } = options

  const session = await startSourceUpload(transport, base, token, { assetId })
  const parts: { partNumber: number; eTag: string }[] = []
  let file: Awaited<ReturnType<typeof open>> | null = null

  try {
    // Opening happens inside the try, because by this point R2 is holding a
    // session for us. A file that will not open — moved, locked by a virus
    // scanner an hour into the transcode — must still cancel it, or the asset
    // can never be given another one.
    file = await open(path, 'r')
    // The server computed the part size from the size this tool reported for
    // this file, so the ranges are the ones it is expecting.
    const ranges = partRanges((await file.stat()).size, session.partSize)
    if (ranges.length !== session.partCount) {
      // The file changed under us between creating the asset and reading it, or
      // the wrong file is open. Either way the parts would not add up to what
      // the server is waiting for, and it would say so after the last one.
      throw new Error('原始檔的大小跟建立影片時不一樣，請重新開始這個工作')
    }

    onProgress({ phase: 'source', assetId, uploaded: 0, total: ranges.length })

    for (const range of ranges) {
      // Checked between parts rather than mid-flight: a part is seconds, and a
      // cancel that only stopped the encoder would leave a multi-gigabyte
      // transfer running with nothing on screen to say so.
      if (isCancelled()) throw new Cancelled('已取消')

      const body = new Uint8Array(range.end - range.start)
      const { bytesRead } = await file.read(body, 0, body.length, range.start)
      if (bytesRead !== body.length) {
        // A short read pads the rest of the part with zeros, and the upload
        // would succeed with a corrupted original nobody could tell from a good
        // one until they tried to re-encode from it.
        throw new Error(`讀取原始檔第 ${range.partNumber} 段時只讀到 ${bytesRead} bytes`)
      }

      const eTag = await withRetry(
        async (attempt) => {
          const granted = await sourcePartUrl(transport, base, token, {
            assetId,
            sessionId: session.sessionId,
            partNumber: range.partNumber,
          })
          try {
            return await putPart(granted.url, body, range.partNumber)
          } catch (error) {
            // A URL that expired while this part was in flight. Asked for again
            // rather than treated as a refusal — but only once, because a second
            // 403 on a URL seconds old is a real one.
            if (error instanceof AdminApiError && error.status === 403 && attempt === 1) {
              const fresh = await sourcePartUrl(transport, base, token, {
                assetId,
                sessionId: session.sessionId,
                partNumber: range.partNumber,
              })
              return await putPart(fresh.url, body, range.partNumber)
            }
            throw error
          }
        },
        {
          attempts: DEFAULT_ATTEMPTS,
          delayMs: 1_000,
          // A part that came back without an ETag is worth sending again: it is
          // not an `AdminApiError`, so it has no status to classify, and the
          // alternative is failing an upload that may simply have lost a header.
          worthRetrying: (error) =>
            !(error instanceof AdminApiError) || isTransient(error.status),
        },
      )

      parts.push({ partNumber: range.partNumber, eTag })
      onProgress({ phase: 'source', assetId, uploaded: parts.length, total: ranges.length })
    }

    const finished = await completeSourceUpload(transport, base, token, {
      assetId,
      sessionId: session.sessionId,
      parts,
    })
    return finished.etag
  } catch (error) {
    // Best effort, and the original failure is what the caller hears about. A
    // cancel that also fails leaves the session to expire, which is the state
    // this was trying to avoid but not a reason to hide why the upload failed.
    await abortSourceUpload(transport, base, token, {
      assetId,
      sessionId: session.sessionId,
    }).catch(() => undefined)
    throw error
  } finally {
    await file?.close().catch(() => undefined)
  }
}
