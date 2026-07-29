function origin(value: string | undefined, fallback: string): string {
  return (value ?? fallback).replace(/\/+$/, '')
}

export const API_BASE = origin(import.meta.env.VITE_API_BASE, 'https://api.luma-studio.tw')
export const PUBLIC_API_BASE = origin(import.meta.env.VITE_PUBLIC_API_BASE, 'https://api.luma-studio.tw')
export const STOREFRONT_ORIGIN = origin(import.meta.env.VITE_STOREFRONT_ORIGIN, 'https://luma-studio.tw')

export function loginUrl(returnTo: string = location.href): string {
  return `${API_BASE}/auth/login?next=${encodeURIComponent(returnTo)}`
}

export function publicImageUrl(key: string): string {
  return `${PUBLIC_API_BASE}/images/${key.split('/').map(encodeURIComponent).join('/')}`
}

export function thumbnailUrl(key: string, size: number): string {
  return `${publicImageUrl(key)}?v=${size}`
}

export function printPageUrl(folder: string): string {
  return `${STOREFRONT_ORIGIN}/ibon_print/${encodeURIComponent(folder)}`
}

export function apiUrl(path: string): string {
  return `${PUBLIC_API_BASE}${path}`
}

export function bioLinkRedirectUrl(itemId: string): string {
  return `${PUBLIC_API_BASE}/r/${encodeURIComponent(itemId)}`
}

export function bioLinkPageUrl(): string {
  return `${STOREFRONT_ORIGIN}/card`
}

