export type AdminRouteId =
  | 'dashboard'
  | 'ibon'
  | 'card'
  | 'products'
  | 'shipping'
  | 'pages'
  | 'site'
  | 'media'
  | 'orders'
  | 'customers'

export interface AdminRoute {
  id: AdminRouteId
  path: string
  label: string
  group: 'site' | 'shop' | 'customers' | 'tools' | null
}

export const ADMIN_ROUTES: readonly AdminRoute[] = [
  { id: 'dashboard', path: '/', label: '總覽', group: null },
  { id: 'ibon', path: '/ibon', label: 'ibon', group: 'tools' },
  { id: 'card', path: '/card', label: '名片', group: 'tools' },
  { id: 'products', path: '/products', label: '商品', group: 'shop' },
  { id: 'shipping', path: '/shipping', label: '運費', group: 'shop' },
  { id: 'pages', path: '/pages', label: '頁面', group: 'site' },
  { id: 'site', path: '/site', label: '頁首/頁尾', group: 'site' },
  { id: 'media', path: '/media', label: '媒體庫', group: 'site' },
  { id: 'orders', path: '/orders', label: '訂單', group: 'shop' },
  { id: 'customers', path: '/customers', label: '會員', group: 'customers' },
]

const dynamic = [
  { id: 'products' as const, pattern: /^\/products\/([^/]+)$/ },
  { id: 'pages' as const, pattern: /^\/pages\/([^/]+)$/ },
]

export function routeById(id: AdminRouteId): AdminRoute {
  return ADMIN_ROUTES.find((route) => route.id === id)!
}

export function routeForPath(value: string): AdminRoute | null {
  const path = value.replace(/\/+$/, '') || '/'
  const exact = ADMIN_ROUTES.find((route) => route.path === path)
  if (exact) return exact
  const matched = dynamic.find((entry) => entry.pattern.test(path))
  return matched ? routeById(matched.id) : null
}

export function routeParam(value: string, id: 'products' | 'pages'): string | null {
  const path = value.replace(/\/+$/, '') || '/'
  const match = dynamic.find((entry) => entry.id === id)?.pattern.exec(path)
  return match ? decodeURIComponent(match[1]!) : null
}
