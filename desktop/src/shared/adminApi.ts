import { normalise, type PairingInput } from './pairing'
import { parseSession, type Session } from './session'

/**
 * Talking to the admin API.
 *
 * Every call takes its transport as an argument. Not for ceremony: it is what
 * lets the interesting parts — which status means what, what is retried, what is
 * never put in a message — be tested without a network or an Electron process,
 * and those are the parts that get them wrong.
 *
 * Nothing in here logs. A request body carries a pairing code and every other
 * request carries a token, so a log line here is a credential written to disk.
 */

export interface HttpResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
  text(): Promise<string>
}

export type Transport = (url: string, init: RequestInit) => Promise<HttpResponse>

export class AdminApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** Errors worth trying again, as opposed to errors worth showing somebody. */
export function isTransient(status: number): boolean {
  // 408 and 429 are the server asking for a moment. 5xx is the server being
  // unwell. Everything else is a decision it has made, and repeating the
  // request will get the same decision — 401 especially, where retrying spends
  // attempts against the pairing lockout.
  return status === 408 || status === 429 || status >= 500
}

async function readError(response: HttpResponse, fallback: string): Promise<never> {
  let message = fallback
  try {
    const body = (await response.json()) as Record<string, unknown> | null
    if (body && typeof body.error === 'string' && body.error) message = body.error
  } catch {
    // A response that is not JSON tells us nothing more than its status did.
  }
  throw new AdminApiError(response.status, message)
}

function authorised(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${token}`, ...extra }
}

export interface CreatedAsset {
  assetId: string
  uploadVersion: number
  encodeVersion: number
}

export interface AssetDetails {
  title: string
  originalFilename?: string
  byteSize: number
  durationSeconds?: number | null
  width?: number | null
  height?: number | null
}

export async function createAsset(
  transport: Transport,
  base: string,
  token: string,
  details: AssetDetails,
): Promise<CreatedAsset> {
  const response = await transport(`${base}/api/video-assets`, {
    method: 'POST',
    headers: authorised(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(details),
  })
  if (!response.ok) await readError(response, '無法建立影片項目')

  const body = (await response.json()) as Record<string, unknown>
  const asset = body.asset as Record<string, unknown> | undefined
  const assetId = typeof asset?.id === 'string' ? asset.id : ''
  const uploadVersion = Number(body.uploadVersion)
  const encodeVersion = Number(body.encodeVersion)
  if (!assetId || !Number.isInteger(uploadVersion) || !Number.isInteger(encodeVersion)) {
    // Carrying on with a missing id would build keys like `videos//1/…`, which
    // the server refuses one object at a time rather than once.
    throw new AdminApiError(response.status, '管理後端沒有回傳影片編號')
  }
  return { assetId, uploadVersion, encodeVersion }
}

export interface GrantedUrl {
  key: string
  url: string
  expiresAt: number
}

export async function uploadUrls(
  transport: Transport,
  base: string,
  token: string,
  options: { assetId: string; encodeVersion: number; keys: readonly string[] },
): Promise<GrantedUrl[]> {
  const response = await transport(
    `${base}/api/video-assets/${encodeURIComponent(options.assetId)}/upload-urls`,
    {
      method: 'POST',
      headers: authorised(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        kind: 'output',
        encodeVersion: options.encodeVersion,
        keys: options.keys,
      }),
    },
  )
  if (!response.ok) await readError(response, '無法取得上傳網址')

  const body = (await response.json()) as Record<string, unknown>
  const granted = Array.isArray(body.urls) ? (body.urls as GrantedUrl[]) : []
  if (granted.length !== options.keys.length) {
    // The server grants a batch or refuses it, so a short answer means
    // something changed under us rather than that some keys were skipped.
    throw new AdminApiError(response.status, '取得的上傳網址數量不符')
  }
  return granted
}

export interface SourceUploadSession {
  sessionId: string
  partSize: number
  partCount: number
  expiresAt: number
}

/**
 * Open the multipart upload for the original file.
 *
 * The server talks to R2 for this, not the tool: the upload id R2 issues has to
 * be written down somewhere that survives this process, and the only thing that
 * can end an upload — complete or abort — needs it.
 */
export async function startSourceUpload(
  transport: Transport,
  base: string,
  token: string,
  options: { assetId: string },
): Promise<SourceUploadSession> {
  const response = await transport(sourcePath(base, options.assetId), {
    method: 'POST',
    headers: authorised(token, { 'Content-Type': 'application/json' }),
    body: '{}',
  })
  if (!response.ok) await readError(response, '無法開始上傳原始檔')

  const body = (await response.json()) as Record<string, unknown>
  const session = {
    sessionId: String(body.sessionId ?? ''),
    partSize: Number(body.partSize ?? 0),
    partCount: Number(body.partCount ?? 0),
    expiresAt: Number(body.expiresAt ?? 0),
  }
  if (!session.sessionId || session.partSize <= 0 || session.partCount <= 0 || session.expiresAt <= 0) {
    // Without these the tool cannot cut the file, and it would find out by
    // sending a part the server refuses.
    throw new AdminApiError(response.status, '伺服器沒有說明要怎麼切這個檔案')
  }
  return session
}

export interface PartUrl {
  url: string
  expiresAt: number
}

/**
 * A URL for one part, asked for immediately before the part is sent.
 *
 * Its own type rather than `GrantedUrl`, which carries the object key the batch
 * upload maps URLs by. A part has no key of its own — every part of a source
 * upload writes the same object — and a list of `GrantedUrl`s with empty keys
 * collapses to one entry the moment somebody builds the same `Map(...)` the
 * encode uploader does.
 *
 * Short-lived: the server signs these for fifteen minutes, and a 64 MiB part on
 * a home connection can outlive that. So the caller asks for one part at a time,
 * just before sending it, rather than taking a batch up front.
 */
export async function sourcePartUrl(
  transport: Transport,
  base: string,
  token: string,
  options: { assetId: string; sessionId: string; partNumber: number },
): Promise<PartUrl> {
  const response = await transport(
    `${sourcePath(base, options.assetId)}/${encodeURIComponent(options.sessionId)}/parts/${options.partNumber}`,
    { method: 'POST', headers: authorised(token, { 'Content-Type': 'application/json' }), body: '{}' },
  )
  if (!response.ok) await readError(response, '無法取得分段上傳網址')

  const body = (await response.json()) as Record<string, unknown>
  const url = String(body.url ?? '')
  const expiresAt = Number(body.expiresAt ?? 0)
  if (!url) throw new AdminApiError(response.status, '伺服器沒有回傳分段上傳網址')
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
    // Zero reads as "already expired" to anything that checks it, which is the
    // one thing this value is for.
    throw new AdminApiError(response.status, '伺服器沒有說明這個網址何時到期')
  }
  return { url, expiresAt }
}

export interface SourceUploadResult {
  etag: string
  alreadyCompleted: boolean
}

export async function completeSourceUpload(
  transport: Transport,
  base: string,
  token: string,
  options: {
    assetId: string
    sessionId: string
    parts: readonly { partNumber: number; eTag: string }[]
  },
): Promise<SourceUploadResult> {
  const response = await transport(
    `${sourcePath(base, options.assetId)}/${encodeURIComponent(options.sessionId)}/complete`,
    {
      method: 'POST',
      headers: authorised(token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ parts: options.parts }),
    },
  )
  if (!response.ok) await readError(response, '無法完成原始檔上傳')

  const body = (await response.json()) as Record<string, unknown>
  return { etag: String(body.etag ?? ''), alreadyCompleted: Boolean(body.alreadyCompleted) }
}

/**
 * Cancel the upload, and say nothing if it was already cancelled.
 *
 * Called when a job is abandoned. Not cancelling leaves parts in R2 that are
 * billed and invisible in a listing, so this runs on the way out of a failure
 * rather than being left to a person who will not know it is there.
 */
export async function abortSourceUpload(
  transport: Transport,
  base: string,
  token: string,
  options: { assetId: string; sessionId: string },
): Promise<void> {
  const response = await transport(
    `${sourcePath(base, options.assetId)}/${encodeURIComponent(options.sessionId)}/abort`,
    { method: 'POST', headers: authorised(token, { 'Content-Type': 'application/json' }), body: '{}' },
  )
  if (!response.ok) await readError(response, '無法取消原始檔上傳')
}

function sourcePath(base: string, assetId: string): string {
  return `${base}/api/video-assets/${encodeURIComponent(assetId)}/source-upload`
}

export interface Registration {
  ok: boolean
  /** Present when the encode is incomplete: every object the server could not find. */
  missing: string[]
  objectCount: number
}

export async function registerEncode(
  transport: Transport,
  base: string,
  token: string,
  details: AssetDetails & { assetId: string; encodeVersion: number },
): Promise<Registration> {
  const response = await transport(`${base}/api/video-assets/import`, {
    method: 'POST',
    headers: authorised(token, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(details),
  })

  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null

  // 409 is not a failure to report as one: it is the list of objects that did
  // not arrive, which is the most useful thing this call can produce.
  if (response.status === 409) {
    const missing = Array.isArray(body?.missing) ? (body!.missing as string[]) : []
    return { ok: false, missing, objectCount: 0 }
  }
  if (!response.ok) {
    throw new AdminApiError(
      response.status,
      typeof body?.error === 'string' ? body.error : '註冊影片失敗',
    )
  }
  return { ok: true, missing: [], objectCount: Number(body?.objectCount ?? 0) }
}

export async function exchangePairing(
  transport: Transport,
  base: string,
  input: PairingInput,
): Promise<Session> {
  const { email, code } = normalise(input)
  const response = await transport(`${base}/api/desktop/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code }),
  })
  if (!response.ok) {
    // The server answers one way for wrong code, spent code, unknown admin and
    // locked account, deliberately. Repeating that here rather than guessing at
    // a friendlier reason keeps the tool from claiming something it cannot know.
    await readError(response, '配對失敗，請重新取得驗證碼')
  }

  const session = parseSession(await response.json())
  if (!session) {
    throw new AdminApiError(response.status, '管理後端回覆的內容無法辨識')
  }
  return session
}
