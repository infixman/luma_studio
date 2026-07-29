import type { MediaSize } from './contracts/media'

export * from './contracts'

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
  /** The hidden-choice Offer used by products sold without options. */
  isDefault: boolean
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
  salesMode: 'single' | 'multi'
  defaultOffer: ProductVariant | null
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
  /** Null when this is the product's no-choice default Offer. */
  title: string | null
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
  /** The page only renders an Offer picker when the customer must choose. */
  requiresOfferSelection: boolean
  variants: PublicVariant[]
  categories: { slug: string; title: string }[]
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
  customerEmail: string
  customerDisplayName: string
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
  cartBlocked: boolean
  accountBlocked: boolean
  notes: string
  anonymizedAt: number | null
  createdAt: number
  orderCount: number
  paidTotal: number
}

export interface AdminCustomerDetail {
  customer: AdminCustomer
  orders: Order[]
  activity: CustomerActivity[]
  stats: CustomerActivityStats
}

export interface CustomerActivity {
  type: 'page_view' | 'product_view' | 'cart_add'
  path: string
  productSlug: string
  productTitle: string
  quantity: number | null
  createdAt: number
}

export interface CustomerActivityStats {
  periodDays: number
  lastSeenAt: number | null
  pageViews: number
  productViews: number
  cartAdds: number
}

/**
 * What every paged list answers with, beside its rows.
 *
 * `total` is a real COUNT, not "how many came back" — a pager that can only
 * say "at least this many" cannot draw a last page.
 */
export interface PageInfo {
  total: number
  page: number
  perPage: number
  /** At least 1: "第 1 頁，共 0 頁" reads as broken. */
  pages: number
  /** How many rows are in this answer. */
  count: number
}

export interface AdminOrderList extends PageInfo {
  orders: AdminOrder[]
  counts: Partial<Record<OrderStatus, number>>
}

// --- custom pages -------------------------------------------------------

export type PageStatus = 'draft' | 'published'

export interface Page {
  id: string
  path: string
  title: string
  status: PageStatus
  /**
   * Where the page stands between its draft and the public.
   *
   * Present on list rows, where it is worked out from timestamps rather than
   * by comparing content — see list_pages. The editor gets the exact answer
   * on PageDetail.
   */
  publishState?: PublishState
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
  format?: 'markdown' | 'html'
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
  interval?: number
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
/**
 * Where a page stands between its draft and what the public can see.
 *
 * `modified` is the one that had no way to be shown before versions existed:
 * edited since it was last published, with nothing anywhere saying so.
 */
export type PublishState = 'draft' | 'published' | 'modified'

/** One entry in the published history. Without its payload — see list_versions. */
export interface PageVersion {
  id: string
  publishedAt: number
  publishedBy: string
  isCurrent: boolean
}

export interface PageDetail {
  page: Page
  blocks: PageBlock[]
  publishState: PublishState
  /** Newest first, capped at 20 by the server. */
  versions: PageVersion[]
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

/**
 * Stock, owned by nothing that has a price.
 *
 * One item can be pointed at by several offers — a material kit sold on its
 * own and included in two course bundles is one pile of stock, not three.
 */
export interface InventoryItem {
  id: string
  sku: string
  title: string
  stock: number
  enabled: boolean
  archived: boolean
  createdAt: number
  updatedAt: number
}

export type CourseStatus = 'draft' | 'published' | 'archived'

/** Phase 2 holds the identity only; sections and lessons arrive in phase 5. */
export interface Course {
  id: string
  slug: string
  title: string
  status: CourseStatus
  createdAt: number
  updatedAt: number
}

export type OfferComponentType = 'course' | 'inventory'

/** One thing an offer delivers. Points at a Course or an InventoryItem. */
export interface OfferComponent {
  id: string
  offerId: string
  type: OfferComponentType
  componentId: string
  quantity: number
  /** Days from first viewing. Null is permanent, and only ever set on a course. */
  accessDays: number | null
  position: number
}

/**
 * What the server makes of an offer's components.
 *
 * Never sent back up: these are derived, and a client that could state them
 * could describe a course as needing postage.
 */
export interface OfferCapabilities {
  containsCourse: boolean
  requiresShipping: boolean
  digitalOnly: boolean
  isBundle: boolean
}

/** Why an offer may not go on sale, in words meant for the editor. */
export interface OfferBlocker {
  reason: 'component_unavailable' | 'no_components' | 'course_not_published'
  message: string
}

export interface OfferComponentsView {
  components: OfferComponent[]
  capabilities: OfferCapabilities
  blockers: OfferBlocker[]
}
