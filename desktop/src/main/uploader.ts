import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'

import { app } from 'electron'

import {
  AdminApiError,
  createAsset,
  isTransient,
  registerEncode,
  uploadUrls,
  type HttpResponse,
  type Transport,
} from '../shared/adminApi'
import {
  URL_BATCH,
  batched,
  contentTypeFor,
  isEncodeObject,
  objectKey,
  toPosix,
  uploadOrder,
} from '../shared/objects'
import { withRetry, DEFAULT_ATTEMPTS } from '../shared/retry'
import type { Progress, ScannedFolder } from '../shared/upload'
import { requireToken } from './session'
import * as ledger from './ledger'

/**
 * Uploading a folder of encoded output.
 *
 * This step deliberately does not transcode. Its input is a directory of
 * finished output, which is how the integration — pairing, presigning, retrying,
 * content types, resuming, registering — was proven before a transcoder existed:
 * that is the part that goes wrong, and it is cheaper to find out with a folder
 * already known to be correct.
 *
 * It stays a separate entrance for the same reason it started as one. Re-sending
 * an encode is minutes; making it again is an hour.
 *
 * Nothing here logs a URL. A presigned URL is a bearer credential and a log
 * outlives its fifteen minutes.
 */

const transport: Transport = (url, init) => fetch(url, init) as Promise<HttpResponse>

function walk(root: string, current = root, found: string[] = []): string[] {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const full = join(current, entry.name)
    if (entry.isDirectory()) walk(root, full, found)
    else if (entry.isFile()) found.push(toPosix(relative(root, full)))
  }
  return found
}

export function scan(folder: string): ScannedFolder {
  const all = walk(folder)
  const objects = uploadOrder(all.filter(isEncodeObject))
  const unexpected = all.filter((path) => !isEncodeObject(path))
  const totalBytes = objects.reduce((sum, path) => sum + statSync(join(folder, path)).size, 0)
  return { folder, objects, unexpected, totalBytes }
}

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
function jobId(folder: string, objects: number, totalBytes: number): string {
  return createHash('sha256')
    .update(`${folder}\0${objects}\0${totalBytes}`)
    .digest('hex')
    .slice(0, 16)
}

async function putObject(url: string, body: Buffer, contentType: string): Promise<void> {
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: new Uint8Array(body),
  })
  if (!response.ok) {
    // The status, never the URL. Errors get pasted into chats.
    throw new AdminApiError(response.status, `上傳失敗（HTTP ${response.status}）`)
  }
}

export type OnProgress = (progress: Progress) => void

export interface FolderUpload {
  folder: string
  title: string
  durationSeconds?: number | null
  width?: number | null
  height?: number | null
}

/**
 * Upload a folder that already contains an encode.
 *
 * Takes a folder rather than deciding whether to make one: that decision is
 * `ingest`'s, and keeping it out of here is what lets this be exercised against
 * output known to be correct.
 */
export async function upload(request: FolderUpload, onProgress: OnProgress): Promise<Progress> {
  const { token, base } = requireToken()

  onProgress({ phase: 'scanning', uploaded: 0, total: 0 })
  const scanned = scan(request.folder)
  if (scanned.objects.length === 0) {
    throw new Error('這個資料夾裡沒有轉檔輸出（找不到 master.m3u8 或任何分段）')
  }

  const id = jobId(request.folder, scanned.objects.length, scanned.totalBytes)
  const saved = ledger.read(id)

  const details = {
    title: request.title || basename(request.folder),
    byteSize: scanned.totalBytes,
    durationSeconds: request.durationSeconds ?? null,
    width: request.width ?? null,
    height: request.height ?? null,
  }

  let assetId = saved?.assetId ?? ''
  let encodeVersion = saved?.encodeVersion ?? 1
  if (!assetId) {
    onProgress({ phase: 'creating', uploaded: 0, total: scanned.objects.length })
    const created = await createAsset(transport, base, token, details)
    assetId = created.assetId
    encodeVersion = created.encodeVersion
    ledger.write(id, { assetId, encodeVersion, done: [] })
  }

  const done = new Set(saved?.done ?? [])
  // Resuming skips what is already up rather than re-transcoding or re-sending.
  // The server would accept a second PUT of the same object, but a two-hour
  // transfer repeated from the start is the thing this avoids.
  const remaining = scanned.objects.filter((path) => !done.has(path))
  let uploaded = done.size

  onProgress({ phase: 'uploading', assetId, uploaded, total: scanned.objects.length })

  const freshUrl = async (path: string): Promise<string> => {
    const key = objectKey(assetId, encodeVersion, path)
    const [granted] = await uploadUrls(transport, base, token, {
      assetId,
      encodeVersion,
      keys: [key],
    })
    if (!granted) throw new Error(`管理後端沒有核發這個檔案的上傳網址：${path}`)
    return granted.url
  }

  for (const batch of batched(remaining, URL_BATCH)) {
    const keys = batch.map((path) => objectKey(assetId, encodeVersion, path))
    const granted = await uploadUrls(transport, base, token, { assetId, encodeVersion, keys })
    const urlFor = new Map(granted.map((entry) => [entry.key, entry.url]))

    for (const path of batch) {
      const key = objectKey(assetId, encodeVersion, path)
      let url = urlFor.get(key)
      if (!url) throw new Error(`管理後端沒有核發這個檔案的上傳網址：${path}`)

      const body = readFileSync(join(request.folder, path))
      await withRetry(
        async (attempt) => {
          try {
            await putObject(url!, body, contentTypeFor(path))
          } catch (error) {
            // The URLs for a batch are granted together and live fifteen
            // minutes. A hundred 1080p segments on a slow connection can take
            // longer than that, at which point every remaining PUT answers 403
            // — so an expired URL is replaced rather than treated as a failure.
            // Once: a second 403 on a fresh URL is a real refusal.
            if (error instanceof AdminApiError && error.status === 403 && attempt === 1) {
              url = await freshUrl(path)
              await putObject(url, body, contentTypeFor(path))
              return
            }
            throw error
          }
        },
        {
          attempts: DEFAULT_ATTEMPTS,
          delayMs: 1_000,
          worthRetrying: (error) => error instanceof AdminApiError && isTransient(error.status),
        },
      )

      done.add(path)
      uploaded += 1
      // Written per object. The alternative is a crash losing a batch of a
      // hundred, which is the difference between resuming and starting again.
      ledger.write(id, { assetId, encodeVersion, done: [...done] })
      onProgress({ phase: 'uploading', assetId, uploaded, total: scanned.objects.length })
    }
  }

  onProgress({ phase: 'registering', assetId, uploaded, total: scanned.objects.length })
  const registered = await registerEncode(transport, base, token, {
    ...details,
    assetId,
    encodeVersion,
  })

  if (!registered.ok) {
    // Not an error: the list of what did not arrive. The ledger keeps what did,
    // so pressing upload again sends only the gap.
    for (const path of registered.missing) done.delete(toPosix(path))
    ledger.write(id, { assetId, encodeVersion, done: [...done] })
    return {
      phase: 'failed',
      assetId,
      uploaded,
      total: scanned.objects.length,
      message: `還缺 ${registered.missing.length} 個檔案，再按一次上傳只會補這些`,
      missing: registered.missing,
    }
  }

  ledger.clear(id)
  return {
    phase: 'done',
    assetId,
    uploaded,
    total: scanned.objects.length,
    message: `已驗證 ${registered.objectCount} 個檔案`,
  }
}

/** Exposed for the About screen and for tests that need the ledger location. */
export function ledgerFolder(): string {
  return app.getPath('userData')
}
