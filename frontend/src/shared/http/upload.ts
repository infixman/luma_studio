import type { BioLinkState, MediaItem, ProductDetail, SiteSettings } from '../types'
import { ApiError, clearLoginAttempt, handleUnauthorized } from './auth'
import { api } from './client'
import { API_BASE } from './urls'

export function dimensionsField(size: { width: number; height: number }): string {
  return `${size.width}x${size.height}`
}

function xhrUpload<T>(path: string, form: FormData, onProgress?: (event: ProgressEvent) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('POST', `${API_BASE}${path}`)
    request.withCredentials = true
    request.setRequestHeader('x-luma-app', '1')
    request.responseType = 'json'
    request.upload.onprogress = (event) => onProgress?.(event)
    request.onerror = () => reject(new ApiError('上傳連線失敗', 0))
    request.onload = () => {
      const body = (request.response ?? {}) as Record<string, unknown>
      if (request.status >= 200 && request.status < 300) {
        clearLoginAttempt()
        resolve(body as T)
      } else if (request.status === 401) {
        reject(handleUnauthorized())
      } else {
        reject(new ApiError(typeof body.error === 'string' ? body.error : '上傳失敗', request.status))
      }
    }
    // The browser sets the multipart boundary.
    request.send(form)
  })
}

export async function uploadProductImage(productId: string, file: File, alt: string): Promise<ProductDetail> {
  const form = new FormData()
  form.append('file', file)
  form.append('alt', alt)
  return api<ProductDetail>(`/api/products/${encodeURIComponent(productId)}/images`, { method: 'POST', body: form })
}

export function uploadMedia(
  upload: {
    file: File
    alt?: string
    title?: string
    dimensions?: { width: number; height: number } | null
    variants?: { label: string; width: number; height: number; blob: Blob }[]
  },
  onProgress?: (ratio: number) => void,
): Promise<{ item: MediaItem }> {
  const form = new FormData()
  form.append('file', upload.file)
  form.append('alt', upload.alt ?? '')
  if (upload.title) form.append('title', upload.title)
  if (upload.dimensions) form.append('dimensions', dimensionsField(upload.dimensions))
  for (const variant of upload.variants ?? []) {
    form.append(`size_${variant.label}`, variant.blob, `${variant.label}.webp`)
    form.append(`size_${variant.label}_dimensions`, dimensionsField(variant))
  }
  return xhrUpload<{ item: MediaItem }>('/api/media', form, (event) => {
    if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total)
  })
}

export async function uploadHeaderImage(file: File): Promise<{ settings: SiteSettings }> {
  const form = new FormData()
  form.append('file', file)
  return api<{ settings: SiteSettings }>('/api/site/header-image', { method: 'POST', body: form })
}

export async function uploadBioLinkAvatar(file: File): Promise<BioLinkState> {
  const form = new FormData()
  form.append('file', file)
  return api<BioLinkState>('/api/bio-link/avatar', { method: 'POST', body: form })
}

export function uploadImage(folder: string, file: File, onProgress: (loaded: number) => void): Promise<{ key: string }> {
  const form = new FormData()
  form.append('folder', folder)
  form.append('file', file)
  return xhrUpload<{ key: string }>('/api/upload', form, (event) => {
    if (event.lengthComputable) onProgress(event.loaded)
  })
}
