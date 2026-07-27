/** The single place that knows where the backend lives and how to talk to it. */

export const API_BASE = (import.meta.env.VITE_API_BASE ?? 'https://luma-studio.infixman.workers.dev').replace(/\/+$/, '')

/** Forces a CORS preflight, which is what stops cross-site forgery of writes. */
const APP_HEADER = { 'x-luma-app': '1' }

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

export function loginUrl(returnTo: string = location.href): string {
  return `${API_BASE}/auth/login?next=${encodeURIComponent(returnTo)}`
}

export function redirectToLogin(): void {
  location.assign(loginUrl())
}

/** Survives the OAuth round trip, so a login that does not stick is detectable. */
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

/**
 * Send the browser to Google once. If the very next request is still 401 the
 * cookie never arrived — usually blocked third-party cookies — so report that
 * instead of bouncing between the API and the login page forever.
 */
function handleUnauthorized(): ApiError {
  if (readFlag(LOGIN_ATTEMPT_KEY)) {
    clearLoginAttempt()
    return new ApiError('登入後仍無法通過驗證，請確認瀏覽器沒有封鎖跨網站 Cookie。', 401)
  }
  writeFlag(LOGIN_ATTEMPT_KEY, true)
  redirectToLogin()
  return new ApiError('需要重新登入', 401)
}

export function publicImageUrl(key: string): string {
  return `${API_BASE}/images/${key.split('/').map(encodeURIComponent).join('/')}`
}

export function printPageUrl(folder: string): string {
  return `${location.origin}/ibon_print/${encodeURIComponent(folder)}`
}

async function readBody(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>
  } catch {
    return {}
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      credentials: 'include',
      headers: { ...APP_HEADER, ...(init.headers ?? {}) },
    })
  } catch {
    throw new ApiError('無法連線到伺服器', 0)
  }
  const body = await readBody(response)
  if (response.status === 401) throw handleUnauthorized()
  if (!response.ok) {
    throw new ApiError(typeof body.error === 'string' ? body.error : '操作失敗', response.status)
  }
  clearLoginAttempt()
  return body as T
}

export async function apiJson<T>(path: string, method: string, payload: unknown): Promise<T> {
  return api<T>(path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })
}

/** XHR rather than fetch: upload progress events have no fetch equivalent. */
export function uploadImage(folder: string, file: File, onProgress: (loaded: number) => void): Promise<{ key: string }> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('POST', `${API_BASE}/api/admin/upload`)
    request.withCredentials = true
    request.setRequestHeader('x-luma-app', '1')
    request.responseType = 'json'
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded)
    }
    request.onerror = () => reject(new ApiError('上傳連線失敗', 0))
    request.onload = () => {
      const body = (request.response ?? {}) as Record<string, unknown>
      if (request.status >= 200 && request.status < 300) {
        resolve(body as { key: string })
        return
      }
      if (request.status === 401) {
        reject(handleUnauthorized())
        return
      }
      reject(new ApiError(typeof body.error === 'string' ? body.error : '上傳失敗', request.status))
    }
    const form = new FormData()
    form.append('folder', folder)
    form.append('file', file)
    request.send(form)
  })
}
