import { useEffect, useState } from 'preact/hooks'

import * as cart from '../lib/cart'

/**
 * The cart's item count, kept in step with localStorage.
 *
 * It subscribes rather than reading once: adding something on a product page
 * has to change the number without a reload, and a second tab editing the
 * same cart should not leave this one showing a stale count.
 */
export function CartLink() {
  const [items, setItems] = useState(0)

  useEffect(() => {
    const refresh = () => setItems(cart.count())
    refresh()
    return cart.onChange(refresh)
  }, [])

  return (
    <a class="cart-link" href="/cart">
      購物車
      {items > 0 && <span class="count">{items}</span>}
    </a>
  )
}
