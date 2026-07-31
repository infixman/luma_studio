export type AdminRouteId =
  | 'dashboard'
  | 'ibon'
  | 'card'
  | 'products'
  | 'inventory'
  | 'courses'
  | 'videos'
  | 'storage'
  | 'categories'
  | 'shipping'
  | 'pages'
  | 'site'
  | 'media'
  | 'orders'
  | 'customers'
  | 'desktopTool'

export interface AdminRoute {
  id: AdminRouteId
  path: string
  label: string
  group: 'site' | 'course' | 'shop' | 'customers' | 'tools' | null
}

export const ADMIN_ROUTES: readonly AdminRoute[] = [
  { id: 'dashboard', path: '/', label: '總覽', group: null },
  { id: 'ibon', path: '/ibon', label: 'ibon', group: 'tools' },
  { id: 'card', path: '/card', label: '名片', group: 'tools' },
  { id: 'products', path: '/products', label: '商品', group: 'shop' },
  { id: 'categories', path: '/categories', label: '商品分類', group: 'shop' },
  { id: 'inventory', path: '/inventory', label: '庫存品', group: 'shop' },
  // Their own group rather than four rows inside 商城. Making a course is a
  // different job from selling one — different day, different person — and the
  // four pages here are used together and almost never with the shop's.
  { id: 'courses', path: '/courses', label: '課程', group: 'course' },
  { id: 'videos', path: '/videos', label: '影片', group: 'course' },
  { id: 'storage', path: '/storage', label: '儲存空間', group: 'course' },
  { id: 'shipping', path: '/shipping', label: '運費', group: 'shop' },
  { id: 'pages', path: '/pages', label: '頁面', group: 'site' },
  { id: 'site', path: '/site', label: '頁首/頁尾', group: 'site' },
  { id: 'media', path: '/media', label: '媒體庫', group: 'site' },
  { id: 'orders', path: '/orders', label: '訂單', group: 'shop' },
  { id: 'customers', path: '/customers', label: '會員', group: 'customers' },
  // With the course pages, not with ibon and the business card: it is how a
  // video gets into the library, which is the job the group above is.
  { id: 'desktopTool', path: '/desktop-tool', label: '桌面工具', group: 'course' },
]

const dynamic = [
  { id: 'products' as const, pattern: /^\/products\/([^/]+)$/ },
  { id: 'pages' as const, pattern: /^\/pages\/([^/]+)$/ },
  { id: 'customers' as const, pattern: /^\/customers\/([^/]+)$/ },
  { id: 'courses' as const, pattern: /^\/courses\/([^/]+)$/ },
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

export function routeParam(value: string, id: 'products' | 'pages' | 'customers' | 'courses'): string | null {
  const path = value.replace(/\/+$/, '') || '/'
  const match = dynamic.find((entry) => entry.id === id)?.pattern.exec(path)
  return match ? decodeURIComponent(match[1]!) : null
}
