/** One thing an offer delivers, named for the customer rather than the system. */
export interface CartLineComponent {
  type: 'course' | 'inventory'
  title: string
}

export interface CartLine {
  /** The same value as offerId. Kept while stored carts still say variantId. */
  variantId: string
  offerId: string
  productSlug: string
  productTitle: string
  /** Empty for a product sold without options. */
  variantTitle: string
  offerTitle: string | null
  imagePath: string | null
  unitPrice: number
  quantity: number
  lineTotal: number
  containsCourse: boolean
  requiresShipping: boolean
  /** What this line grants and posts, so the page can say so before payment. */
  components: CartLineComponent[]
  stockLeft: number | null
}

export interface CartProblem {
  variantId: string
  offerId: string
  title?: string
  reason:
    | 'unavailable'
    | 'out_of_stock'
    | 'reduced'
    /** More of a course than one grant. */
    | 'quantity_not_allowed'
    /** The offer stands but something it promised is gone. */
    | 'component_unavailable'
  available?: number
}

export interface ShippingQuote {
  method: string
  label: string
  fee: number
  freeThreshold: number | null
}

export interface CartQuote {
  lines: CartLine[]
  problems: CartProblem[]
  subtotal: number
  /**
   * Only the lines that are actually posted.
   *
   * Free-delivery thresholds are quoted against this, so a course in the cart
   * cannot push an order over a threshold it did not pay towards.
   */
  shippingSubtotal: number
  requiresShipping: boolean
  containsCourse: boolean
  /** Empty when nothing needs posting. */
  shipping: ShippingQuote[]
}

export interface ShippingMethod {
  method: string
  label: string
  enabled: boolean
  fee: number
  freeThreshold: number | null
  position: number
}

/**
 * What an empty cart looks like without asking the server.
 *
 * Shared so that a new field on CartQuote cannot be added to one page's
 * literal and forgotten in the other's.
 */
export const EMPTY_CART_QUOTE: CartQuote = {
  lines: [],
  problems: [],
  subtotal: 0,
  shippingSubtotal: 0,
  requiresShipping: false,
  containsCourse: false,
  shipping: [],
}
