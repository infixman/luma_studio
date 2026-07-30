import { AdminApiError, exchangePairing } from '../shared/adminApi'
import { resolveAdminApi, UnsafeEndpoint } from '../shared/endpoint'
import { isUsable, secondsLeft, type Session, type SessionStatus } from '../shared/session'
import type { PairingInput } from '../shared/pairing'
import * as store from './store'
import { transport } from './transport'

/**
 * The pairing token, and the fact that the interface never sees it.
 *
 * Every request that needs the token is made here, in the main process. The
 * renderer asks for outcomes — "pair with this code", "is there a session" — and
 * gets back facts about the session rather than the session itself. A token in
 * the renderer would be a token reachable by anything that ever got a script
 * into that window, and the whole point of a scoped credential is that losing
 * the tool is not losing the shop.
 */

let current: Session | null = null

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function endpoint(): { base: string | null; problem: string | null } {
  try {
    return { base: resolveAdminApi(process.env.LUMA_ADMIN_API), problem: null }
  } catch (error) {
    if (error instanceof UnsafeEndpoint) return { base: null, problem: error.message }
    throw error
  }
}

export function restore(): void {
  const remembered = store.load()
  // A remembered token that has already expired is not worth keeping around to
  // fail with. Dropping it here means the interface opens on the pairing screen
  // rather than on an upload screen that refuses everything.
  current = isUsable(remembered, nowSeconds()) ? remembered : null
  if (remembered && !current) store.clear()
}

export function status(): SessionStatus {
  const { base, problem } = endpoint()
  const live = isUsable(current, nowSeconds())
  return {
    paired: live,
    adminEmail: live ? current!.adminEmail : null,
    secondsLeft: live ? secondsLeft(current, nowSeconds()) : 0,
    remembered: store.canPersist(),
    endpoint: base ?? '',
    endpointProblem: problem,
  }
}

export async function pair(input: PairingInput): Promise<SessionStatus> {
  const { base, problem } = endpoint()
  if (!base) throw new Error(problem ?? '管理後端網址無法使用')

  const granted = await exchangePairing(transport, base, input)
  current = granted
  store.save(granted)
  return status()
}

export function signOut(): SessionStatus {
  current = null
  store.clear()
  return status()
}

/**
 * The token, for the upload code in this process only.
 *
 * Not exposed over IPC. Throws rather than returning null so a caller cannot
 * accidentally send an unauthenticated request and read the 401 as something
 * else.
 */
export function requireToken(): { token: string; base: string } {
  const { base, problem } = endpoint()
  if (!base) throw new Error(problem ?? '管理後端網址無法使用')
  if (!isUsable(current, nowSeconds())) {
    throw new AdminApiError(401, '配對已過期，請重新配對')
  }
  return { token: current!.token, base }
}
