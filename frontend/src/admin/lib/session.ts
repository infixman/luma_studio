/**
 * Who is signed in, for the one place that shows it.
 *
 * The gate already asks `/api/session` before it renders anything, so the
 * answer exists — it was just being thrown away. Keeping it here means the
 * sidebar can name the account without a second request, and without the
 * email being threaded through every page as a prop.
 *
 * A module variable rather than storage: it is somebody's email address, and
 * a shared machine should not still know it after they sign out.
 */

let email = ''

export function rememberSignedIn(value: string): void {
  email = value
}

export function signedInEmail(): string {
  return email
}
