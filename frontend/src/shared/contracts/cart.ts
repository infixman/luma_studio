export interface CartLine {
  variantId: string
  productSlug: string
  productTitle: string
  variantTitle: string
  imagePath: string | null
  unitPrice: number
  quantity: number
  lineTotal: number
  stockLeft: number | null
}

export interface CartProblem {
  variantId: string
  title?: string
  reason: 'unavailable' | 'out_of_stock' | 'reduced'
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
