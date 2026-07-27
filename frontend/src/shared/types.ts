export interface PrintResult {
  id: string
  pincode: string
  deadline: string
  qrCodeSvg: string
  files: string[]
  selectType: string
  printSpec: string
  cached: boolean
  cachedAt: number
  cacheExpiresAt: number
}

export interface FolderListing {
  folders: string[]
  truncated: boolean
}

export interface StoredObject {
  key: string
  name: string
  size: number
}

export interface ObjectListing {
  folder: string
  objects: StoredObject[]
  truncated: boolean
}

export type BioLinkKind = 'link' | 'social'

/** An item as the editor sees it. */
export interface BioLinkItem {
  id: string
  kind: BioLinkKind
  title: string
  url: string
  platform: string | null
  enabled: boolean
  // No `position`: the array's order is the page's order, and a second
  // representation of the same thing is one that can disagree with it.
}

/** What the editor loads and every mutation returns. */
export type BioLinkTheme = 'warm' | 'ink' | 'forest' | 'sand' | 'night'
export type BioLinkShape = 'rounded' | 'pill' | 'square'
export type BioLinkFont = 'sans' | 'serif'

export interface BioLinkStyle {
  theme: BioLinkTheme
  buttonShape: BioLinkShape
  fontStyle: BioLinkFont
}

export interface BioLinkEvent {
  id: string
  title: string
  start: string
  end: string
  allDay: boolean
  location: string
  description: string
}

export interface BioLinkCalendarData {
  title: string
  events: BioLinkEvent[]
}

export interface BioLinkState extends BioLinkStyle {
  displayName: string
  bio: string
  avatarPath: string | null
  calendarUrl: string
  calendarTitle: string
  calendarCount: number
  calendarEnabled: boolean
  items: BioLinkItem[]
}

export interface LabelledTotal {
  label: string
  total: number
}

/** Distinct visitors, not raw hits: events are deduped per visitor per day. */
export interface BioLinkStats {
  days: number
  since: string
  views: number
  clicks: number
  daily: { day: string; views: number; clicks: number }[]
  items: { id: string; title: string; total: number }[]
  countries: LabelledTotal[]
  referrers: LabelledTotal[]
  devices: LabelledTotal[]
}

/** The trimmed shape anonymous visitors receive. */
export interface PublicBioLink {
  displayName: string
  bio: string
  avatarPath: string | null
  style: BioLinkStyle
  // Whether to ask for one, not the schedule itself: it is fetched separately
  // so a slow calendar cannot hold up the links.
  hasCalendar: boolean
  links: { id: string; title: string }[]
  socials: { id: string; title: string; platform: string | null }[]
}

export interface PrintSettingsResponse {
  folder: string
  selectType: string
  printSpec: string
  cacheInvalidated?: boolean
}

// --- shop ---------------------------------------------------------------

export type ProductStatus = 'draft' | 'active' | 'archived'

export interface Product {
  id: string
  slug: string
  title: string
  description: string
  status: ProductStatus
  position: number
  createdAt: number
  updatedAt: number
}

/** Prices and stock are whole New Taiwan dollars and whole units. */
export interface ProductVariant {
  id: string
  productId: string
  title: string
  sku: string
  price: number
  stock: number
  position: number
  enabled: boolean
}

export interface ProductImage {
  id: string
  productId: string
  path: string | null
  alt: string
  position: number
}

/** One product with everything the editor needs to render it. */
export interface ProductDetail {
  product: Product
  variants: ProductVariant[]
  images: ProductImage[]
}

/** The catalogue list, with children keyed by product id. */
export interface ProductListing {
  products: Product[]
  variants: Record<string, ProductVariant[]>
  images: Record<string, ProductImage[]>
}

/** What an anonymous visitor is told about a variant. Stock is deliberately vague above the low-stock threshold. */
export interface PublicVariant {
  id: string
  title: string
  price: number
  inStock: boolean
  stockLeft: number | null
}

/** One card on the shop index. */
export interface PublicProductCard {
  slug: string
  title: string
  coverPath: string | null
  priceFrom: number | null
  priceTo: number | null
  inStock: boolean
}

export interface PublicProductDetail {
  slug: string
  title: string
  description: string
  images: { path: string | null; alt: string }[]
  variants: PublicVariant[]
}
