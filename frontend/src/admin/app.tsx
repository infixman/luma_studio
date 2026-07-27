import { AdminPage } from './pages/AdminPage'
import { BioLinkAdminPage } from './pages/BioLinkAdminPage'
import { ProductEditPage } from './pages/ProductEditPage'
import { ProductsPage } from './pages/ProductsPage'
import { ShippingPage } from './pages/ShippingPage'

const PRODUCT_PATH = /^\/products\/([^/]+)$/

/**
 * The back office is its own deployment, so its paths carry no /admin
 * segment: every page on admin.luma-studio.tw is administration.
 */
function markBody(page: string): void {
  document.body.className = page
}

export function App() {
  const path = location.pathname.replace(/\/+$/, '') || '/'
  markBody('admin')

  if (path === '/bio-link') return <BioLinkAdminPage />
  if (path === '/products') return <ProductsPage />
  if (path === '/shipping') return <ShippingPage />

  const product = PRODUCT_PATH.exec(path)
  if (product) return <ProductEditPage id={decodeURIComponent(product[1]!)} />

  // Anything else lands on the folder manager rather than a dead end. The
  // old /admin and /admin/bio-link URLs arrive here through the storefront's
  // redirect, and a bookmark that lands on a blank page reads as a fault.
  return <AdminPage />
}
