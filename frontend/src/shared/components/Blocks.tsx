import { useEffect, useState } from 'preact/hooks'

import { apiUrl } from '../api'
import { renderMarkdown } from '../markdown'
import type { ContactDetail, MediaRef, PageBlock, PublicProductCard } from '../types'
import './blocks.css'

/**
 * Renders a page's blocks. Shared deliberately.
 *
 * The storefront uses this to show a published page; the back office uses it
 * to preview a draft. That is the whole reason drafts never need to be
 * fetchable from the public API — what the owner sees in the editor is what
 * a visitor will see, because it is the same component.
 *
 * Every block draws from `data`, which the API resolved from the ids in
 * `config`. Nothing here turns an id into a picture, so nothing here has to
 * decide what to do when the picture is gone: it simply is not in `data`.
 *
 * Adding a block type means adding a case here and a validator in
 * backend/src/pages.py. Nothing else in the page machinery changes.
 */
export function Blocks({ blocks }: { blocks: PageBlock[] }) {
  return (
    <>
      {blocks.map((block) => (
        <Block key={block.id} block={block} />
      ))}
    </>
  )
}

function Block({ block }: { block: PageBlock }) {
  switch (block.type) {
    case 'text':
      // The HTML is produced by renderMarkdown, which escapes its input before
      // applying any rule — the only tags here are ones that file wrote.
      return (
        <section
          class="block block-text"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(block.config.body ?? '') }}
        />
      )

    case 'carousel':
      return <Carousel slides={block.data?.slides ?? []} ratio={block.config.ratio} autoplay={block.config.autoplay} />

    case 'album':
      return <Album images={block.data?.images ?? []} columns={block.config.columns} ratio={block.config.ratio} />

    case 'shop':
      return (
        <ShopRow
          heading={block.config.heading}
          products={block.data?.products ?? []}
          layout={block.config.layout}
          overlayLabels={block.config.overlayLabels}
        />
      )

    case 'about':
      return <About block={block} />

    case 'contact':
      return <Contact block={block} />

    default:
      // A type the API validated but this build has no case for. Rendering
      // nothing is right; the editor is where an unknown block gets dealt with.
      return null
  }
}

function Picture({ image, className }: { image: MediaRef; className?: string }) {
  return <img class={className} src={apiUrl(image.path)} alt={image.alt} loading="lazy" />
}

function Carousel({
  slides,
  ratio,
  autoplay,
}: {
  slides: { image: MediaRef; caption: string; href: string }[]
  ratio: string
  autoplay: boolean
}) {
  const [index, setIndex] = useState(0)
  const total = slides.length

  useEffect(() => {
    if (!autoplay || total < 2) return
    // Slow on purpose. A carousel that moves before the caption has been read
    // is a carousel nobody reads.
    const timer = setInterval(() => setIndex((current) => (current + 1) % total), 6000)
    return () => clearInterval(timer)
  }, [autoplay, total])

  if (total === 0) return null
  const current = slides[Math.min(index, total - 1)]!

  return (
    <section class={`block block-carousel ratio-${ratio}`} aria-roledescription="carousel">
      <div class="frame">
        {current.href ? (
          <a href={current.href}>
            <Picture image={current.image} />
          </a>
        ) : (
          <Picture image={current.image} />
        )}

        {total > 1 && (
          <>
            <button
              type="button"
              class="arrow prev"
              aria-label="上一張"
              onClick={() => setIndex((current) => (current - 1 + total) % total)}
            >
              ‹
            </button>
            <button
              type="button"
              class="arrow next"
              aria-label="下一張"
              onClick={() => setIndex((current) => (current + 1) % total)}
            >
              ›
            </button>
          </>
        )}
      </div>

      {current.caption && <p class="caption">{current.caption}</p>}

      {total > 1 && (
        <ol class="dots">
          {slides.map((slide, position) => (
            <li key={slide.image.id}>
              <button
                type="button"
                class={position === index ? 'current' : ''}
                aria-label={`第 ${position + 1} 張`}
                aria-current={position === index}
                onClick={() => setIndex(position)}
              />
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function Album({ images, columns, ratio }: { images: MediaRef[]; columns: number; ratio: string }) {
  if (images.length === 0) return null
  return (
    <section class={`block block-album columns-${columns} ratio-${ratio}`}>
      <ul>
        {images.map((image) => (
          <li key={image.id}>
            {/* The full image opens in its own tab rather than in a lightbox:
                a lightbox is a modal to build, trap focus in and dismiss, and
                the browser already has a perfectly good way to show a photo. */}
            <a href={apiUrl(image.path)} target="_blank" rel="noopener">
              <Picture image={image} />
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}

function priceLabel(card: PublicProductCard): string {
  if (card.priceFrom === null) return '暫不販售'
  if (card.priceTo === null || card.priceFrom === card.priceTo) return `NT$${card.priceFrom}`
  return `NT$${card.priceFrom}–${card.priceTo}`
}

/**
 * A row of products, in one of two arrangements.
 *
 * `grid` is the even row of tiles this block has always drawn. `featured`
 * gives the first product a tile twice the size of the rest — a shop that
 * sells illustrations has work that deserves more room than a 190px square,
 * and every tile the same size means none of it gets any.
 *
 * Which product is large is simply the first one in the block's list. There
 * is no "featured" flag, because a flag plus an ordered list is two ways of
 * saying which product comes first, and they would disagree.
 *
 * `overlayLabels` puts the name and price on the artwork instead of under it,
 * and is off by default. The demo this came from lays its labels over a black
 * space photograph; an illustration carries its subject across the whole
 * frame, so the text lands on the part that matters. When it is on, the label
 * is pinned to one corner over a solid backdrop, so it stays readable
 * whatever is behind it.
 */
function ShopRow({
  heading,
  products,
  layout,
  overlayLabels,
}: {
  heading: string
  products: PublicProductCard[]
  layout: string
  overlayLabels: boolean
}) {
  // An empty row is drawn as nothing rather than as a heading over a gap. The
  // editor is where "this block shows no products" needs saying.
  if (products.length === 0) return null

  return (
    <section class={`block block-shop layout-${layout}${overlayLabels ? ' overlay-labels' : ''}`}>
      {heading && <h2>{heading}</h2>}
      <ul>
        {products.map((card) => (
          <li key={card.slug} class={card.inStock ? '' : 'sold-out'}>
            <a href={`/shop/${encodeURIComponent(card.slug)}`}>
              <span class="cover">
                {card.coverPath ? <img src={apiUrl(card.coverPath)} alt="" loading="lazy" /> : <span />}
                {!card.inStock && <span class="ribbon">售完</span>}
              </span>
              {/* One wrapper for both lines, so the overlay moves them together
                  rather than needing two sets of coordinates. */}
              <span class="label">
                <span class="title">{card.title}</span>
                <span class="price">{priceLabel(card)}</span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** The heading each kind of detail is filed under. */
export const CONTACT_LABELS: Record<ContactDetail['kind'], string> = {
  email: '電子郵件',
  phone: '電話',
  address: '地址',
  hours: '營業時間',
  note: '其他',
}

/**
 * The address a detail links to, or null when it is only worth reading.
 *
 * The scheme is written here and never taken from the value, so what the
 * owner typed cannot become one — `mailto:` and `tel:` are the only two that
 * appear, whatever is in the field.
 */
export function contactHref(detail: ContactDetail): string | null {
  const value = detail.value.trim()
  if (!value) return null
  // Not percent-encoded: `@` survives every mail client and reads back as the
  // address the owner typed, which is what a copied link should say.
  if (detail.kind === 'email') return `mailto:${value}`
  if (detail.kind === 'phone') {
    // Spaces and dashes are how a phone number is written for a person to
    // read; a dialler wants neither.
    const digits = value.replace(/[^+\d]/g, '')
    return digits ? `tel:${digits}` : null
  }
  return null
}

/**
 * How to reach the shop on one side, a picture or a passage on the other.
 *
 * Layout only, and deliberately so: there is no form here. The site's CSP is
 * `form-action 'none'` and nothing on the backend receives a message, so a
 * form would mean a new public endpoint, bot protection, a rate limit and
 * outbound mail. What it would add over an address printed in plain sight is
 * only "without showing the address".
 */
function Contact({ block }: { block: Extract<PageBlock, { type: 'contact' }> }) {
  const { heading, details, aside, body, detailsSide } = block.config
  const image = block.data?.image ?? null
  // The other half is drawn only when it has something in it; without it the
  // details take the whole width rather than sitting beside a gap.
  const hasAside = aside === 'image' ? Boolean(image) : Boolean(body)

  return (
    <section class={`block block-contact details-${detailsSide} ${hasAside ? '' : 'alone'}`}>
      <div class="details">
        {heading && <h2>{heading}</h2>}
        {details.length > 0 && (
          <dl>
            {details.map((detail, index) => {
              const href = contactHref(detail)
              return (
                // Keyed by position: the same kind may appear twice, for a
                // studio line and a workshop line.
                <div class="detail" key={index}>
                  <dt>{CONTACT_LABELS[detail.kind]}</dt>
                  <dd>{href ? <a href={href}>{detail.value}</a> : detail.value}</dd>
                </div>
              )
            })}
          </dl>
        )}
      </div>

      {hasAside && (
        <div class="aside">
          {aside === 'image' && image ? (
            <Picture image={image} />
          ) : (
            // Same escape-first renderer as everywhere else, so a paragraph
            // behaves the same wherever it is written.
            <div class="body" dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }} />
          )}
        </div>
      )}
    </section>
  )
}

function About({ block }: { block: Extract<PageBlock, { type: 'about' }> }) {
  const { heading, body, imageSide, links } = block.config
  const image = block.data?.image ?? null

  return (
    <section class={`block block-about ${image ? `image-${imageSide}` : 'no-image'}`}>
      {image && (
        <div class="portrait">
          <Picture image={image} />
        </div>
      )}
      <div class="words">
        {heading && <h2>{heading}</h2>}
        {/* Same escape-first renderer as the text block, so one paragraph of
            prose behaves the same wherever it is written. */}
        {body && <div class="body" dangerouslySetInnerHTML={{ __html: renderMarkdown(body) }} />}
        {links.length > 0 && (
          <ul class="links">
            {links.map((link) => (
              <li key={link.url}>
                <a href={link.url} rel="noopener">
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
