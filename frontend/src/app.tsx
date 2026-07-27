import { AdminPage } from './pages/AdminPage'
import { HomePage } from './pages/HomePage'
import { PrintPage } from './pages/PrintPage'

const PRINT_PATH = /^\/ibon_print\/([^/]+)$/

/**
 * Both pages' stylesheets end up in one bundle, so each page's rules are
 * scoped to a body class rather than bleeding into the other page.
 */
function markBody(page: string): void {
  document.body.className = page
}

/** A handful of entry points, no in-app navigation, so matching the path is enough. */
export function App() {
  const path = location.pathname.replace(/\/+$/, '') || '/'

  if (path === '/') {
    markBody('home')
    return <HomePage />
  }

  if (path === '/admin') {
    markBody('admin')
    return <AdminPage />
  }

  const print = PRINT_PATH.exec(path)
  if (print) {
    markBody('print')
    return <PrintPage id={decodeURIComponent(print[1]!)} />
  }

  markBody('landing')
  return (
    <main class="landing">
      <div class="brand">
        <img src="/assets/luma-studio-logo.png" alt="苒光繪誌" />
      </div>
      <p>這個網址沒有對應的頁面。</p>
      <p>
        <a href="/admin">前往管理介面</a>
      </p>
    </main>
  )
}
