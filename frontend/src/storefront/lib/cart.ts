/**
 * The cart, as the browser remembers it.
 *
 * Nothing but variant ids and quantities is stored. Prices, names and
 * availability are recomputed by the server on every view, so a cart that has
 * sat in a tab for a week cannot show a stale price, and editing localStorage
 * by hand buys nothing but a rejected request.
 */

const KEY = 'luma-cart'
const CHANGED = 'luma-cart-changed'

/* Both mirror backend/src/cart.py. The browser's copy only decides what the
   number field will accept; the one that matters is the server's, which
   re-checks every line at checkout. */
export const MAX_LINES = 20
export const MAX_QUANTITY = 99

export interface CartLine {
  variantId: string
  quantity: number
}

function clamp(quantity: number): number {
  return Math.min(Math.max(Math.trunc(quantity), 1), MAX_QUANTITY)
}

export function read(): CartLine[] {
  let raw: string | null
  try {
    raw = localStorage.getItem(KEY)
  } catch {
    // Private modes can refuse storage entirely. An empty cart is a worse
    // experience than a remembered one, but it is not a broken page.
    return []
  }
  if (!raw) return []

  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (line): line is CartLine =>
          typeof line === 'object' &&
          line !== null &&
          typeof (line as CartLine).variantId === 'string' &&
          Number.isFinite((line as CartLine).quantity),
      )
      .map((line) => ({ variantId: line.variantId, quantity: clamp(line.quantity) }))
      .slice(0, MAX_LINES)
  } catch {
    return []
  }
}

function write(lines: CartLine[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(lines))
  } catch {
    /* Nothing useful to do: the cart simply will not survive this tab. */
  }
  // Lets a header count update without every page polling storage.
  window.dispatchEvent(new CustomEvent(CHANGED))
}

export function count(): number {
  return read().reduce((total, line) => total + line.quantity, 0)
}

/** Returns false when the cart is already full of other items. */
export function add(variantId: string, quantity = 1): boolean {
  const lines = read()
  const existing = lines.find((line) => line.variantId === variantId)
  if (existing) {
    existing.quantity = clamp(existing.quantity + quantity)
  } else {
    if (lines.length >= MAX_LINES) return false
    lines.push({ variantId, quantity: clamp(quantity) })
  }
  write(lines)
  return true
}

export function setQuantity(variantId: string, quantity: number): void {
  if (quantity < 1) {
    remove(variantId)
    return
  }
  const lines = read().map((line) => (line.variantId === variantId ? { ...line, quantity: clamp(quantity) } : line))
  write(lines)
}

export function remove(variantId: string): void {
  write(read().filter((line) => line.variantId !== variantId))
}

export function clear(): void {
  write([])
}

/**
 * Drop lines the server says are gone.
 *
 * Called after the cart is priced, so an item that was removed from sale
 * stops reappearing every time the page loads.
 */
export function forget(variantIds: string[]): void {
  if (variantIds.length === 0) return
  const gone = new Set(variantIds)
  write(read().filter((line) => !gone.has(line.variantId)))
}

export function onChange(listener: () => void): () => void {
  window.addEventListener(CHANGED, listener)
  // Another tab editing the same cart fires `storage`, not our event.
  window.addEventListener('storage', listener)
  return () => {
    window.removeEventListener(CHANGED, listener)
    window.removeEventListener('storage', listener)
  }
}
