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
