import { loginUrl } from './urls'

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

const LOGIN_ATTEMPT_KEY = 'luma-login-attempted'

function readFlag(key: string): boolean {
  try {
    return sessionStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

function writeFlag(key: string, value: boolean): void {
  try {
    if (value) sessionStorage.setItem(key, '1')
    else sessionStorage.removeItem(key)
  } catch {
    /* Private modes can refuse storage; the loop guard is best effort. */
  }
}

export function clearLoginAttempt(): void {
  writeFlag(LOGIN_ATTEMPT_KEY, false)
}

export function redirectToLogin(): void {
  location.assign(loginUrl())
}

/** See `api` and `xhrUpload`: one failed OAuth round trip must not loop forever. */
export function handleUnauthorized(): ApiError {
  if (readFlag(LOGIN_ATTEMPT_KEY)) {
    clearLoginAttempt()
    return new ApiError('登入後仍無法通過驗證，請確認瀏覽器沒有封鎖跨網站 Cookie。', 401)
  }
  writeFlag(LOGIN_ATTEMPT_KEY, true)
  redirectToLogin()
  return new ApiError('需要重新登入', 401)
}

