/** The single place that knows where the backend lives and how to talk to it. */

import type { BioLinkState, MediaItem, ProductDetail, SiteSettings } from './types'

function origin(value: string | undefined, fallback: string): string {
  return (value ?? fallback).replace(/\/+$/, '')
}

/**
 * Where this build sends its authenticated calls.
 *
 * The storefront talks to the public API; the back office talks to the admin
 * API. They are separate Workers with separate session cookies, so this is
 * per-build rather than per-call.
 */
export const API_BASE = origin(import.meta.env.VITE_API_BASE, 'https://api.luma-studio.tw')

/**
 * Images, avatars and click-counted redirects, which the public API serves
 * for both builds.
 *
 * The back office needs these too — its thumbnail grid and its avatar preview
 * are the same public URLs a customer sees — so it cannot simply use
 * API_BASE, which for that build points at the admin Worker.
 */
export const PUBLIC_API_BASE = origin(import.meta.env.VITE_PUBLIC_API_BASE, 'https://api.luma-studio.tw')

/**
 * The customer-facing site, for links the back office hands out.
 *
 * A print page or bio link URL built from `location.origin` would read
 * https://admin.luma-studio.tw/... inside the back office — a link that works
 * for nobody but the owner, and only while signed in.
 */
export const STOREFRONT_ORIGIN = origin(import.meta.env.VITE_STOREFRONT_ORIGIN, 'https://luma-studio.tw')

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
  return `${PUBLIC_API_BASE}/images/${key.split('/').map(encodeURIComponent).join('/')}`
}

/**
 * The same image, but keyed to this version of the file.
 *
 * Replacing an image reuses its filename, so the edge cache would keep
 * serving the previous one for up to an hour. The size changes whenever the
 * bytes do, which is enough to make the admin's thumbnail follow the upload.
 * Links handed to customers stay clean and use `publicImageUrl`.
 */
export function thumbnailUrl(key: string, size: number): string {
  return `${publicImageUrl(key)}?v=${size}`
}

export function printPageUrl(folder: string): string {
  return `${STOREFRONT_ORIGIN}/ibon_print/${encodeURIComponent(folder)}`
}

/** Avatars and click-counted redirects are served by the API, not the site. */
export function apiUrl(path: string): string {
  return `${PUBLIC_API_BASE}${path}`
}

export function bioLinkRedirectUrl(itemId: string): string {
  return `${PUBLIC_API_BASE}/r/${encodeURIComponent(itemId)}`
}

export function bioLinkPageUrl(): string {
  return `${STOREFRONT_ORIGIN}/card`
}

export async function uploadProductImage(productId: string, file: File, alt: string): Promise<ProductDetail> {
  const form = new FormData()
  form.append('file', file)
  form.append('alt', alt)
  // No content-type header: the browser has to set the multipart boundary.
  return api<ProductDetail>(`/api/products/${encodeURIComponent(productId)}/images`, { method: 'POST', body: form })
}

export async function uploadMedia(file: File, alt: string): Promise<{ item: MediaItem }> {
  const form = new FormData()
  form.append('file', file)
  form.append('alt', alt)
  // No content-type header: the browser has to set the multipart boundary.
  return api<{ item: MediaItem }>('/api/media', { method: 'POST', body: form })
}

export async function uploadHeaderImage(file: File): Promise<{ settings: SiteSettings }> {
  const form = new FormData()
  form.append('file', file)
  // No content-type header: the browser has to set the multipart boundary.
  return api<{ settings: SiteSettings }>('/api/site/header-image', { method: 'POST', body: form })
}

export async function uploadBioLinkAvatar(file: File): Promise<BioLinkState> {
  const form = new FormData()
  form.append('file', file)
  // No content-type header: the browser has to set the multipart boundary.
  return api<BioLinkState>('/api/bio-link/avatar', { method: 'POST', body: form })
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

/**
 * Ask who is signed in, without acting on the answer.
 *
 * `api` sends a 401 straight to Google, which is right once a page has decided
 * the visitor belongs there. It is wrong for the question "does this visitor
 * belong here at all" — that has to be answerable as "no" so the caller can
 * show a door instead of a dashboard.
 */
export async function probeSession<T>(path: string): Promise<T | null> {
  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, { credentials: 'include', headers: APP_HEADER })
  } catch {
    throw new ApiError('無法連線到伺服器', 0)
  }
  if (response.status === 401) return null
  const body = await readBody(response)
  if (!response.ok) throw new ApiError(typeof body.error === 'string' ? body.error : '操作失敗', response.status)
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
    request.open('POST', `${API_BASE}/api/upload`)
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
