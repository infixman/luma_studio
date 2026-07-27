import { AdminPage } from './pages/AdminPage'
import { BioLinkAdminPage } from './pages/BioLinkAdminPage'

/**
 * The back office is its own deployment, so its paths carry no /admin
 * segment: every page on admin.luma-studio.tw is administration.
 */
function markBody(page: string): void {
  document.body.className = page
}

export function App() {
  const path = location.pathname.replace(/\/+$/, '') || '/'

  if (path === '/bio-link') {
    markBody('admin')
    return <BioLinkAdminPage />
  }

  // Anything else lands on the folder manager rather than a dead end. The
  // old /admin and /admin/bio-link URLs arrive here through the storefront's
  // redirect, and a bookmark that lands on a blank page reads as a fault.
  markBody('admin')
  return <AdminPage />
}
