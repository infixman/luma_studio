import { API_BASE } from '../../shared/http/urls'

export interface CustomerEvent {
  type: 'page_view' | 'product_view' | 'cart_add'
  path?: string
  productSlug?: string
  productTitle?: string
  quantity?: number
}

/**
 * Activity is supporting information, never a reason to interrupt shopping.
 * The API accepts it only for a signed-in customer; anonymous visits and
 * network failures are deliberately silent.
 */
export function track(event: CustomerEvent): void {
  void fetch(`${API_BASE}/api/customer-events`, {
    method: 'POST',
    credentials: 'include',
    keepalive: true,
    headers: {
      'content-type': 'application/json',
      'x-luma-app': '1',
    },
    body: JSON.stringify(event),
  }).catch(() => undefined)
}
