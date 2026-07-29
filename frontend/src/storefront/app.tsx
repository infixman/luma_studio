import { BioLinkPage } from './pages/BioLinkPage'
import { PreviewPage } from './pages/PreviewPage'
import { PrintPage } from './pages/PrintPage'
import { Chrome } from './components/Chrome'
import { CartPage } from './pages/CartPage'
import { CategoryPage } from './pages/CategoryPage'
import { CustomPage } from './pages/CustomPage'
import { CheckoutPage } from './pages/CheckoutPage'
import { ProductPage } from './pages/ProductPage'
import { OrderPage } from './pages/OrderPage'
import { OrdersPage } from './pages/OrdersPage'
import { MyCoursesPage } from './pages/MyCoursesPage'
import { LearnPage } from './pages/LearnPage'
import { ShopPage } from './pages/ShopPage'

const PRINT_PATH = /^\/ibon_print\/([^/]+)$/
// Underscores are what keep this from colliding with a page somebody builds:
// a page path is letters, digits and single hyphens (see the pages domain
// validation contract), so no page can ever be created at this address.
const PREVIEW_PATH = /^\/__preview\/([A-Za-z0-9_-]{20,64})$/
// /shop/c/... is matched first, so a category filter is never read as a
// product slug. The `c` segment exists to make that impossible either way.
const CATEGORY_PATH = /^\/shop\/c\/(.+)$/
const PRODUCT_PATH = /^\/shop\/([^/]+)$/
const ORDER_PATH = /^\/orders\/([^/]+)$/
const LEARN_PATH = /^\/learn\/([^/]+)$/

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
  return (
    path === '/checkout' ||
    path === '/card' ||
    path.startsWith('/ibon_print/') ||
    // The preview is the one path this site lets itself be framed on, and the
    // argument for allowing that is that it renders and offers nothing. The
    // header carries a cart, a login link and the owner's own call to action,
    // so wearing it would have made that argument false.
    path.startsWith('/__preview/')
  )
}

/** A handful of entry points, no in-app navigation, so matching the path is enough. */
export function App() {
  const path = location.pathname.replace(/\/+$/, '') || '/'
  return <Chrome bare={isBare(path)}>{route()}</Chrome>
}

function route() {
  const path = location.pathname.replace(/\/+$/, '') || '/'

  // The front door is a page the shop builds in the back office. There is no
  // hard-coded home page behind it: one existed while the page system was
  // being built, and keeping it would mean the front door could be edited in
  // two places, only one of which anybody would think to look at.
  if (path === '/') {
    markBody('custom-page')
    return <CustomPage path="/" onMissing={noHomeYet} />
  }

  // Before everything else: it is the one route the site lets itself be
  // framed on, so it must not be reachable by accident from another match.
  const preview = PREVIEW_PATH.exec(path)
  if (preview) {
    markBody('custom-page')
    return <PreviewPage token={preview[1]!} />
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

  if (path === '/account/courses') {
    markBody('courses')
    return <MyCoursesPage />
  }

  const learn = LEARN_PATH.exec(path)
  if (learn) {
    markBody('learn')
    return <LearnPage slug={decodeURIComponent(learn[1]!)} />
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

/* Neither of these draws the studio's mark. The site header above them
   already carries it, and a second copy underneath is what the shop pages
   used to do wrong. */

function noHomeYet() {
  markBody('landing')
  return (
    <main class="landing">
      <p>首頁還沒有建立。</p>
      <p>
        <a class="inline-action" href="/shop">先去看看商品</a>
      </p>
    </main>
  )
}

function notFound() {
  markBody('landing')
  return (
    <main class="landing not-found">
      <section class="not-found-content" aria-labelledby="not-found-title">
        <div class="not-found-art" aria-hidden="true">
          <img src="/assets/luma-studio-logo.png" alt="" />
          <svg class="not-found-wanderer" viewBox="0 0 180 120">
            <path class="not-found-path" d="M16 104C38 90 56 96 76 82c19-13 28-31 48-35 15-3 27 2 42-10" />
            <circle cx="91" cy="61" r="7" />
            <path d="M91 69v24m0-17-14 10m14-10 13 7m-13 10-10 19m10-19 12 17" />
            <path class="not-found-question" d="M134 18c0-9 15-10 15 0 0 7-8 7-8 14m0 10v1" />
          </svg>
        </div>

        <p class="not-found-code">404 · OOPS!</p>
        <h1 id="not-found-title">你找的頁面好像迷路了</h1>
        <p class="not-found-message">這個網址可能已經搬家，或是不小心走進了不存在的小徑。</p>
        <a class="not-found-home" href="/">回到首頁</a>
      </section>
    </main>
  )
}
