import { ApiError, clearLoginAttempt, handleUnauthorized } from './auth'
import { API_BASE } from './urls'

const APP_HEADER = { 'x-luma-app': '1' }

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
  if (!response.ok) throw new ApiError(typeof body.error === 'string' ? body.error : '操作失敗', response.status)
  clearLoginAttempt()
  return body as T
}

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
