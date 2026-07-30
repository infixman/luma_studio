/**
 * What the tool holds after pairing, and when it stops being useful.
 *
 * A token is a bearer credential with a twelve-hour life. Nothing here decides
 * whether it is *valid* — only the server can say that, and it re-checks the
 * admin allowlist on every request — but the tool has to know when to stop
 * offering to upload with one, because the alternative is discovering it
 * halfway through a two-hour transfer.
 */

export interface Session {
  token: string
  adminEmail: string
  scope: string
  /** Seconds since the epoch, as the server reported it. */
  expiresAt: number
}

/**
 * Treat a token as finished slightly before it is.
 *
 * An upload started with four seconds left is an upload that fails, and it
 * fails after the transcode rather than before it. The margin is what makes
 * "signed in" mean "can still finish something".
 */
export const EXPIRY_MARGIN_SECONDS = 5 * 60

export function isUsable(session: Session | null, nowSeconds: number): boolean {
  if (!session?.token || !session.adminEmail) return false
  return session.expiresAt - EXPIRY_MARGIN_SECONDS > nowSeconds
}

export function secondsLeft(session: Session | null, nowSeconds: number): number {
  if (!session) return 0
  return Math.max(0, session.expiresAt - nowSeconds)
}

/**
 * Read a session back out of storage.
 *
 * Anything unexpected is no session rather than a crash: this comes off disk,
 * where a half-written file, an older format or a manual edit are all possible,
 * and the recovery in every case is the same — ask the admin to pair again.
 */
export function parseSession(raw: unknown): Session | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Record<string, unknown>
  const { token, adminEmail, scope, expiresAt } = value
  if (typeof token !== 'string' || token.length === 0) return null
  if (typeof adminEmail !== 'string' || adminEmail.length === 0) return null
  if (typeof scope !== 'string' || scope.length === 0) return null
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return null
  return { token, adminEmail, scope, expiresAt }
}


/**
 * What the interface is allowed to know about the session.
 *
 * Deliberately not the session: no token. It lives in `shared` rather than with
 * the main process because all three sides refer to it, and a renderer importing
 * a type out of `main/` reads as though it could import the rest.
 */
export interface SessionStatus {
  paired: boolean
  adminEmail: string | null
  secondsLeft: number
  /** False on machines where the OS offers no encryption; see `main/store.ts`. */
  remembered: boolean
  endpoint: string
  endpointProblem: string | null
}
