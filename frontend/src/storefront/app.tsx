import { BioLinkPage } from './pages/BioLinkPage'
import { HomePage } from './pages/HomePage'
import { PrintPage } from './pages/PrintPage'
import { Chrome } from './components/Chrome'
import { CartPage } from './pages/CartPage'
import { CategoryPage } from './pages/CategoryPage'
import { CustomPage } from './pages/CustomPage'
import { CheckoutPage } from './pages/CheckoutPage'
import { ProductPage } from './pages/ProductPage'
import { OrderPage } from './pages/OrderPage'
import { OrdersPage } from './pages/OrdersPage'
import { ShopPage } from './pages/ShopPage'

const PRINT_PATH = /^\/ibon_print\/([^/]+)$/
// /shop/c/... is matched first, so a category filter is never read as a
// product slug. The `c` segment exists to make that impossible either way.
const CATEGORY_PATH = /^\/shop\/c\/(.+)$/
const PRODUCT_PATH = /^\/shop\/([^/]+)$/
const ORDER_PATH = /^\/orders\/([^/]+)$/

/**
 * Every page's stylesheet ends up in one bundle, so each page's rules are
 * scoped to a body class rather than bleeding into the others.
 */
function markBody(page: string): void {
  document.body.className = page
}

/**
 * Which pages wear no site header or footer.
 *
 * Two reasons, and they are different ones:
 *
 * Paying — a navigation bar part way through checkout only offers ways to
 * stop.
 *
 * Standing alone — the name card and the ibon pickup page are not pages of a
 * shop. One is a link handed out on its own; the other is opened at a counter
 * in a convenience store, on a phone, to read one number off it. Both already
 * carry the studio's own mark, so the site chrome puts a second logo above
 * the first and a shopping cart in front of someone who is trying to print.
 *
 * The order pages are neither. Somebody looking up what they bought is
 * browsing, and taking the navigation away from them only makes the shop
 * harder to get back to.
 */
export function isBare(path: string): boolean {
  return path === '/checkout' || path === '/card' || path.startsWith('/ibon_print/')
}

/** A handful of entry points, no in-app navigation, so matching the path is enough. */
export function App() {
  const path = location.pathname.replace(/\/+$/, '') || '/'
  return <Chrome bare={isBare(path)}>{route()}</Chrome>
}

function route() {
  const path = location.pathname.replace(/\/+$/, '') || '/'

  // A page flagged as home takes over /, and the built-in one is the
  // fallback rather than the other way round — so nothing goes blank before
  // anyone has built a home page.
  if (path === '/') {
    markBody('custom-page')
    return <CustomPage path="/" onMissing={() => { markBody('home'); return <HomePage /> }} />
  }

  if (path === '/card') {
    markBody('bio')
    return <BioLinkPage />
  }

  if (path === '/shop') {
    markBody('shop')
    return <ShopPage />
  }

  if (path === '/cart') {
    markBody('cart')
    return <CartPage />
  }

  if (path === '/checkout') {
    markBody('checkout')
    return <CheckoutPage />
  }

  if (path === '/orders') {
    markBody('orders')
    return <OrdersPage />
  }

  const order = ORDER_PATH.exec(path)
  if (order) {
    markBody('order')
    return <OrderPage id={decodeURIComponent(order[1]!)} />
  }

  const category = CATEGORY_PATH.exec(path)
  if (category) {
    markBody('shop')
    return <CategoryPage filter={category[1]!} />
  }

  const product = PRODUCT_PATH.exec(path)
  if (product) {
    markBody('product')
    return <ProductPage slug={decodeURIComponent(product[1]!)} />
  }

  const print = PRINT_PATH.exec(path)
  if (print) {
    markBody('print')
    return <PrintPage id={decodeURIComponent(print[1]!)} />
  }

  // Last: anything the routes above did not claim might be a built page, so
  // ask before saying it does not exist. A 404 is not a hot path, and the
  // alternative — baking every page path into the bundle — would make adding
  // a page a deploy.
  markBody('custom-page')
  return <CustomPage path={path} onMissing={notFound} />
}

function notFound() {
  markBody('landing')
  return (
    <main class="landing">
      <div class="brand">
        <img src="/assets/luma-studio-logo.png" alt="苒光繪誌" />
      </div>
      <p>這個網址沒有對應的頁面。</p>
    </main>
  )
}
