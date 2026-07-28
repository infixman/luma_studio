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
  categories: Category[]
}

/** The catalogue list, with children keyed by product id. */
export interface ProductListing {
  products: Product[]
  variants: Record<string, ProductVariant[]>
  images: Record<string, ProductImage[]>
  categories: Category[]
  /** Active-product count per category id, so the editor needs one call. */
  counts: Record<string, number>
  productCategories: Record<string, Category[]>
}

/** Flat and many-to-many — a tag, not a branch of a tree. */
export interface Category {
  id: string
  slug: string
  title: string
  description: string
  position: number
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

export interface PublicCategory {
  slug: string
  title: string
  productCount: number
}

/** A category page, which may name several categories at once. */
export interface CategoryPageData {
  title: string
  /** Only a single category carries one; no one blurb describes a combination. */
  description: string
  mode: 'any' | 'all'
  categories: { slug: string; title: string }[]
  products: PublicProductCard[]
}

export interface PublicProductDetail {
  slug: string
  title: string
  description: string
  images: { path: string | null; alt: string }[]
  variants: PublicVariant[]
  categories: { slug: string; title: string }[]
}

/** One cart line as the server rebuilt it. Prices never come from the browser. */
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

/** Why a line the browser remembered did not survive repricing. */
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

/** The editable shape the back office uses. */
export interface ShippingMethod {
  method: string
  label: string
  enabled: boolean
  fee: number
  freeThreshold: number | null
  position: number
}

export interface Customer {
  id: string
  email: string
  displayName: string
  recipientName: string
  recipientPhone: string
  address: string
  blocked: boolean
}

export type OrderStatus = 'pending' | 'paid' | 'shipped' | 'completed' | 'cancelled' | 'expired'

export interface Order {
  id: string
  status: OrderStatus
  subtotal: number
  shippingFee: number
  total: number
  shippingMethod: string
  recipientName: string
  recipientPhone: string
  recipientEmail: string
  shippingAddress: string
  storeName: string | null
  storeAddr: string | null
  reservedUntil: number | null
  paidAt: number | null
  createdAt: number
}

/** Titles and prices are snapshots taken when the order was placed. */
export interface OrderItem {
  productTitle: string
  variantTitle: string
  unitPrice: number
  quantity: number
  subtotal: number
}

/**
 * The same line, plus a picture of the product as it is now.
 *
 * Both are null once the product has been deleted, which is why they are not
 * on `OrderItem` itself: the snapshot above always reads, and these two are
 * decoration that may be missing.
 */
export interface OrderCardItem extends OrderItem {
  slug: string | null
  coverPath: string | null
}

export interface OrderDetail {
  order: Order
  items: OrderCardItem[]
}

/** One row of the customer's order list: the order, and what was in it. */
export interface OrderCard extends Order {
  items: OrderCardItem[]
}

/** The same order plus what only the shop may see. */
export interface AdminOrder extends Order {
  customerId: string
  adminNote: string
}

export interface PaymentAttempt {
  merTradeNo: string
  amount: number
  status: string
  createdAt: number
}

export interface OrderAuditEntry {
  actor: string
  action: string
  fromStatus: string | null
  toStatus: string | null
  detail: string
  createdAt: number
}

/** One queued notification, and whether it went. */
export interface OrderEmail {
  kind: string
  recipient: string
  subject: string
  status: 'pending' | 'sent' | 'failed'
  attempts: number
  lastError: string
  createdAt: number
  sentAt: number | null
}

export interface AdminOrderDetail {
  order: AdminOrder
  items: OrderItem[]
  attempts: PaymentAttempt[]
  audit: OrderAuditEntry[]
  emails: OrderEmail[]
}

export interface AdminCustomer {
  id: string
  email: string
  displayName: string
  recipientName: string
  recipientPhone: string
  address: string
  blocked: boolean
  anonymizedAt: number | null
  createdAt: number
  orderCount: number
  paidTotal: number
}

export interface AdminCustomerDetail {
  customer: AdminCustomer
  orders: Order[]
}

export interface AdminOrderList {
  orders: AdminOrder[]
  counts: Partial<Record<OrderStatus, number>>
  /** True when the answer stopped at its limit and more rows exist. */
  truncated: boolean
}

// --- custom pages -------------------------------------------------------

export type PageStatus = 'draft' | 'published'

export interface Page {
  id: string
  path: string
  title: string
  status: PageStatus
  isHome: boolean
  showHeader: boolean
  showFooter: boolean
  /* What a shared link shows. The key round-trips so saving a title cannot
     drop an image the editor never touched; the path is what draws it. */
  shareDescription: string
  shareImageKey: string
  shareImagePath: string | null
  position: number
  updatedAt: number
}

/* A block's config shape depends on its type, so the block is a union rather
   than one shape with optional fields — a carousel and a paragraph have
   nothing in common but an id and a position.

   `config` is what the editor sends back, unchanged: ids, not pictures.
   `data` is what the API resolved from those ids so the block can be drawn.
   Keeping them apart is why a deleted image costs one slide instead of the
   page: the id stays in the config to be repaired. */

export type BlockRatio = 'wide' | 'square' | 'tall'
export type BlockColumns = 2 | 3 | 4
export type BlockType = 'text' | 'carousel' | 'album' | 'shop' | 'about' | 'contact'

/** One image as the API resolved it. */
export interface MediaRef {
  id: string
  path: string
  alt: string
  /** The original's width, or 0 for an image uploaded before widths were kept. */
  width: number
  /** Narrower copies, so a phone is not sent the original. Empty for older uploads. */
  sizes: MediaSize[]
}

export interface TextBlockConfig {
  body: string
}

export interface CarouselSlide {
  mediaId: string
  caption: string
  href: string
}

export interface CarouselConfig {
  slides: CarouselSlide[]
  ratio: BlockRatio
  autoplay: boolean
}

export interface AlbumConfig {
  mediaIds: string[]
  columns: BlockColumns
  ratio: BlockRatio
}

export type ShopLayout = 'grid' | 'featured'

export interface ShopBlockConfig {
  heading: string
  source: 'products' | 'category'
  slugs: string[]
  filter: string
  limit: number
  /* `featured` enlarges the first product in the list above. There is no
     separate flag saying which one is large, because that would be a second
     ordering competing with `slugs`. */
  layout: ShopLayout
  /** Names and prices over the artwork. Off by default — see ShopRow. */
  overlayLabels: boolean
}

export interface AboutConfig {
  heading: string
  body: string
  mediaId: string
  imageSide: 'left' | 'right'
  links: { label: string; url: string }[]
}

/* Layout only. There is no form: the CSP is `form-action 'none'` and nothing
   on the backend receives a message, so a form would be a new endpoint, bot
   protection, a rate limit and mail — a separate piece of work. */
export type ContactKind = 'email' | 'phone' | 'address' | 'hours' | 'note'

export interface ContactDetail {
  kind: ContactKind
  value: string
}

export interface ContactConfig {
  heading: string
  details: ContactDetail[]
  /** What fills the other column: a picture, or a passage of prose. */
  aside: 'image' | 'text'
  mediaId: string
  body: string
  detailsSide: 'left' | 'right'
}

export type BlockConfig =
  | TextBlockConfig
  | CarouselConfig
  | AlbumConfig
  | ShopBlockConfig
  | AboutConfig
  | ContactConfig

interface BlockBase {
  id: string
  position: number
}

export type PageBlock =
  | (BlockBase & { type: 'text'; config: TextBlockConfig; data?: Record<string, never> })
  | (BlockBase & {
      type: 'carousel'
      config: CarouselConfig
      data?: { slides: { image: MediaRef; caption: string; href: string }[] }
    })
  | (BlockBase & { type: 'album'; config: AlbumConfig; data?: { images: MediaRef[] } })
  | (BlockBase & { type: 'shop'; config: ShopBlockConfig; data?: { products: PublicProductCard[] } })
  | (BlockBase & { type: 'about'; config: AboutConfig; data?: { image: MediaRef | null } })
  | (BlockBase & { type: 'contact'; config: ContactConfig; data?: { image: MediaRef | null } })

/** What the back office edits. */
export interface PageDetail {
  page: Page
  blocks: PageBlock[]
}

/** What the storefront renders. Drafts never reach this shape. */
export interface PageContent {
  title: string
  path: string
  showHeader: boolean
  showFooter: boolean
  /* Read by the storefront Worker, not by the app: the crawlers these are
     for never run the JavaScript that would set them. */
  shareDescription: string
  shareImagePath: string | null
  blocks: PageBlock[]
}

// --- site chrome --------------------------------------------------------

export type SiteColour = 'cream' | 'sand' | 'clay' | 'forest' | 'ink'
export type SiteTone = 'dark' | 'light'
export type SiteSize = 'small' | 'medium' | 'large'

/** Every appearance field is a choice from a fixed set, never a typed value. */
export interface SiteSettings {
  headerBackground: 'transparent' | 'solid' | 'image'
  headerColour: SiteColour
  headerImagePath: string | null
  headerHeight: SiteSize
  headerText: SiteTone
  headerLogoSize: SiteSize
  headerSticky: boolean
  headerShowCart: boolean
  headerShowLogin: boolean
  headerCtaLabel: string
  headerCtaUrl: string
  footerColour: SiteColour
  footerText: SiteTone
  /** The sentence under the mark in the footer's brand column. */
  footerBlurb: string
  footerCopyright: string
  footerColumns: { title: string; links: { label: string; url: string }[] }[]
  footerSocials: { platform: string; url: string }[]
}

/** What the back office edits: the target is an id or slug, not a URL. */
export interface MenuItem {
  id: string
  parentId: string | null
  label: string
  targetKind: 'page' | 'category' | 'url'
  target: string
  position: number
}

/** The menu plus everything an item may point at, so the editor needs one call. */
export interface MenuState {
  menu: MenuItem[]
  pages: { id: string; title: string; path: string; status: 'draft' | 'published' }[]
  categories: { slug: string; title: string }[]
}

/** What the storefront gets: targets already resolved to hrefs. */
export interface ResolvedMenuItem {
  id: string
  parentId: string | null
  label: string
  href: string
}

export interface SiteChrome {
  settings: SiteSettings
  menu: ResolvedMenuItem[]
}

/** One image in the library. Blocks store the id; `url` is for drawing it. */
export interface MediaItem {
  id: string
  path: string
  fileName: string
  /** The owner's own label, for finding it again. Empty falls back to the file name. */
  title: string
  /** Read out to somebody who cannot see the picture. Never the same field as the title. */
  alt: string
  tags: string[]
  byteSize: number
  /** The original's own pixels. Zero means nobody measured it — see MediaSize. */
  width: number
  height: number
  /**
   * The same picture stored again at narrower widths, narrowest first.
   *
   * Rendered by the browser that uploaded it, because a Python Worker has no
   * image library and paying for it once beats paying for it on every page
   * load. Empty is normal: an image already narrower than the smallest target
   * has nothing to scale down to, and one the browser could not decode was
   * kept as it arrived rather than refused.
   */
  sizes: MediaSize[]
  createdAt: number
}

export interface MediaSize {
  label: 'small' | 'medium' | 'large'
  path: string
  width: number
  height: number
  byteSize: number
}

// --- back-office dashboard ----------------------------------------------

/** What the shop looks like right now, in one answer. */
export interface DashboardSummary {
  orders: {
    pending: number
    paid: number
    shipped: number
    completed: number
    /** Paid and not yet shipped — somebody has given the shop money and is waiting. */
    waiting: number
  }
  /** Taken in the last thirty days, counted from when payment landed. */
  revenue: { orders: number; total: number }
  lowStock: { id: string; productTitle: string; variantTitle: string; slug: string; stock: number }[]
  recentPages: { id: string; title: string; path: string; status: PageStatus; updatedAt: number }[]
  /** The threshold the shop is being warned against, so the UI can say it. */
  lowStockAt: number
}
