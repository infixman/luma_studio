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
