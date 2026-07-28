import { AdminGate } from './components/AdminGate'
import { AdminPage } from './pages/AdminPage'
import { BioLinkAdminPage } from './pages/BioLinkAdminPage'
import { PageEditPage } from './pages/PageEditPage'
import { PagesPage } from './pages/PagesPage'
import { ProductEditPage } from './pages/ProductEditPage'
import { ProductsPage } from './pages/ProductsPage'
import { ShippingPage } from './pages/ShippingPage'
import { MediaPage } from './pages/MediaPage'
import { OrdersAdminPage } from './pages/OrdersAdminPage'
import { SitePage } from './pages/SitePage'

const PRODUCT_PATH = /^\/products\/([^/]+)$/
const PAGE_PATH = /^\/pages\/([^/]+)$/

/**
 * The back office is its own deployment, so its paths carry no /admin
 * segment: every page on admin.luma-studio.tw is administration.
 */
function markBody(page: string): void {
  document.body.className = page
}

function Routed() {
  const path = location.pathname.replace(/\/+$/, '') || '/'

  if (path === '/card') return <BioLinkAdminPage />
  if (path === '/products') return <ProductsPage />
  if (path === '/shipping') return <ShippingPage />
  if (path === '/pages') return <PagesPage />
  if (path === '/site') return <SitePage />
  if (path === '/media') return <MediaPage />
  if (path === '/orders') return <OrdersAdminPage />

  const page = PAGE_PATH.exec(path)
  if (page) return <PageEditPage id={decodeURIComponent(page[1]!)} />

  const product = PRODUCT_PATH.exec(path)
  if (product) return <ProductEditPage id={decodeURIComponent(product[1]!)} />

  // Anything else lands on the folder manager rather than a dead end. The
  // old /admin and /admin/bio-link URLs arrive here through the storefront's
  // redirect, and a bookmark that lands on a blank page reads as a fault.
  return <AdminPage />
}

export function App() {
  markBody('admin')

  // The gate renders nothing of the back office until there is a session, so
  // the routing below never runs for a visitor who has not signed in.
  return (
    <AdminGate>
      <Routed />
    </AdminGate>
  )
}
