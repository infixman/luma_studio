import { AdminGate } from './components/AdminGate'
import { RichTextEditorPreview } from './components/RichTextEditorPreview'
import { AdminPage } from './pages/AdminPage'
import { DashboardPage } from './pages/DashboardPage'
import { BioLinkAdminPage } from './features/bio-link/BioLinkAdminPage'
import { PageEditPage } from './features/pages/PageEditPage'
import { PagesPage } from './features/pages/PagesPage'
import { ProductCreatePage } from './pages/ProductCreatePage'
import { ProductEditPage } from './pages/ProductEditPage'
import { ProductsPage } from './pages/ProductsPage'
import { CategoriesPage } from './pages/CategoriesPage'
import { ShippingPage } from './pages/ShippingPage'
import { MediaPage } from './pages/MediaPage'
import { CustomersPage } from './pages/CustomersPage'
import { CustomerDetailPage } from './pages/CustomerDetailPage'
import { OrdersAdminPage } from './pages/OrdersAdminPage'
import { SitePage } from './features/site/SitePage'
import { routeForPath, routeParam } from './routes'

/**
 * The back office is its own deployment, so its paths carry no /admin
 * segment: every page on admin.luma-studio.tw is administration.
 */
function markBody(page: string): void {
  document.body.className = page
}

function Routed() {
  const path = location.pathname.replace(/\/+$/, '') || '/'

  const route = routeForPath(path)
  switch (route?.id) {
    case 'dashboard': return <DashboardPage />
    case 'ibon': return <AdminPage />
    case 'card': return <BioLinkAdminPage />
    case 'products': {
      const id = routeParam(path, 'products')
      if (id === 'new') return <ProductCreatePage />
      return id ? <ProductEditPage id={id} /> : <ProductsPage />
    }
    case 'categories': return <CategoriesPage />
    case 'shipping': return <ShippingPage />
    case 'pages': {
      const id = routeParam(path, 'pages')
      return id ? <PageEditPage id={id} /> : <PagesPage />
    }
    case 'site': return <SitePage />
    case 'media': return <MediaPage />
    case 'orders': return <OrdersAdminPage />
    case 'customers': {
      const id = routeParam(path, 'customers')
      return id ? <CustomerDetailPage id={id} /> : <CustomersPage />
    }
  }

  // Anything else lands on the dashboard rather than a dead end. The old
  // /admin and /admin/bio-link URLs arrive here through the storefront's
  // redirect, and a bookmark that lands on a blank page reads as a fault.
  return <DashboardPage />
}

export function App() {
  markBody('admin')

  // A local visual check must not require a real session. Vite replaces DEV
  // with false in the production bundle, so this path can never bypass the
  // deployed AdminGate.
  if (import.meta.env.DEV && location.pathname === '/__preview/rich-text') {
    return <RichTextEditorPreview />
  }

  // The gate renders nothing of the back office until there is a session, so
  // the routing below never runs for a visitor who has not signed in.
  return (
    <AdminGate>
      <Routed />
    </AdminGate>
  )
}
