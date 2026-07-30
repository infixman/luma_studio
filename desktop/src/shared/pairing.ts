/**
 * Turning what somebody typed into what the server will accept.
 *
 * The back office displays the code as `418 302`, because six digits in a row
 * are hard to read off a screen. So that is what gets typed and pasted, and the
 * server accepts exactly six digits and nothing else — without stripping the
 * space here, the tool would refuse the code the page just showed it and blame
 * the admin for it.
 */

/** How long a code is, server-side. Not a display choice. */
export const CODE_LENGTH = 6

export interface PairingInput {
  email: string
  code: string
}

export function normaliseEmail(value: string): string {
  // Lowercased because that is how the session table holds it and how the seed
  // is derived. A capital letter would derive a different seed and produce a
  // correct code that never matches.
  return value.trim().toLowerCase()
}

export function normaliseCode(value: string): string {
  // Every kind of separator somebody might paste, not just the space the page
  // renders: a copy out of a chat window arrives with all sorts.
  return value.replace(/[\s ._-]/g, '')
}

export function normalise(input: PairingInput): PairingInput {
  return { email: normaliseEmail(input.email), code: normaliseCode(input.code) }
}

export type PairingField = 'email' | 'code'

export interface PairingProblem {
  field: PairingField
  message: string
}

/**
 * Why this cannot be submitted yet, or null.
 *
 * Checked here as well as at the server so the tool can say something useful
 * before spending a code — a wrong-length code is not a failed pairing, and
 * submitting it would burn an attempt against the lockout.
 *
 * The field is part of the answer rather than something the caller works out by
 * matching on the message: the interface marks the field that is wrong, and a
 * screen that decides which one by searching for 「信箱」 in a sentence breaks the
 * moment the sentence is reworded.
 */
export function problemWith(input: PairingInput): PairingProblem | null {
  const { email, code } = normalise(input)
  if (!email) return { field: 'email', message: '請輸入管理者信箱' }
  // Deliberately shallow. The server holds the list of who is an admin, and a
  // clever local pattern would only ever disagree with it.
  if (!email.includes('@')) return { field: 'email', message: '這看起來不是一個信箱地址' }
  if (!code) return { field: 'code', message: '請輸入驗證碼' }
  if (code.length !== CODE_LENGTH || !/^[0-9]+$/.test(code)) {
    return { field: 'code', message: `驗證碼是 ${CODE_LENGTH} 位數字` }
  }
  return null
}
