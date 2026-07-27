import { BioLinkPage } from './pages/BioLinkPage'
import { HomePage } from './pages/HomePage'
import { PrintPage } from './pages/PrintPage'
import { CartPage } from './pages/CartPage'
import { CheckoutPage } from './pages/CheckoutPage'
import { ProductPage } from './pages/ProductPage'
import { OrderPage } from './pages/OrderPage'
import { OrdersPage } from './pages/OrdersPage'
import { ShopPage } from './pages/ShopPage'

const PRINT_PATH = /^\/ibon_print\/([^/]+)$/
const PRODUCT_PATH = /^\/shop\/([^/]+)$/
const ORDER_PATH = /^\/orders\/([^/]+)$/

/**
 * Every page's stylesheet ends up in one bundle, so each page's rules are
 * scoped to a body class rather than bleeding into the others.
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

  if (path === '/bio_link') {
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
