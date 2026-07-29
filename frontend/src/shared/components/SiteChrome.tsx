import { useEffect, useState } from 'preact/hooks'

import { SocialIcon } from './SocialIcon'
import type { ResolvedMenuItem, SiteSettings } from '../types'
import './site-chrome.css'

/**
 * The header and footer every page wears.
 *
 * Shared so the back office's appearance settings can preview them with the
 * same code the storefront renders — the same reason the block components
 * live here.
 *
 * Every appearance value arrives already constrained to a fixed set by the
 * API, so these become class names rather than inline styles. Nothing the
 * owner typed becomes CSS.
 */

function children(menu: ResolvedMenuItem[], parentId: string | null): ResolvedMenuItem[] {
  return menu.filter((item) => item.parentId === parentId)
}

function MenuTree({ menu, parentId, depth }: { menu: ResolvedMenuItem[]; parentId: string | null; depth: number }) {
  const items = children(menu, parentId)
  if (items.length === 0) return null

  return (
    <ul class={`menu-level depth-${depth}`}>
      {items.map((item) => {
        const nested = children(menu, item.id)
        return (
          <li key={item.id} class={nested.length ? 'has-children' : ''}>
            <a href={item.href}>{item.label}</a>
            <MenuTree menu={menu} parentId={item.id} depth={depth + 1} />
          </li>
        )
      })}
    </ul>
  )
}

/**
 * Drawn rather than written, because the count has to sit on top of it.
 *
 * A word cannot carry a badge without the badge either pushing the word along
 * or covering a letter; a 22px square can, and every shop the customer has
 * used puts the number in that corner.
 */
function CartGlyph() {
  return (
    <svg
      class="cart-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M2.6 3h2.1l2.4 10.6a1.6 1.6 0 0 0 1.56 1.25h7.8a1.6 1.6 0 0 0 1.56-1.23L19.6 7H6" />
      <circle cx="9.5" cy="19.4" r="1.4" />
      <circle cx="16.6" cy="19.4" r="1.4" />
    </svg>
  )
}

export function SiteHeader({
  settings,
  menu,
  cartCount,
  signedIn,
  loginHref,
}: {
  settings: SiteSettings
  menu: ResolvedMenuItem[]
  cartCount?: number
  signedIn?: boolean
  loginHref?: string
}) {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const classes = [
    'site-header',
    `bg-${settings.headerBackground}`,
    `colour-${settings.headerColour}`,
    `height-${settings.headerHeight}`,
    `text-${settings.headerText}`,
    settings.headerSticky ? 'sticky' : '',
    open ? 'open' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <header class={classes}>
      {/* The image sits in its own layer with an overlay above it, so the
          menu stays readable whatever photograph gets uploaded. */}
      {settings.headerBackground === 'image' && settings.headerImagePath && (
        <div class="header-image" style={{ backgroundImage: `url(${settings.headerImagePath})` }} aria-hidden="true" />
      )}

      <div class="header-inner">
        <a class={`brand size-${settings.headerLogoSize}`} href="/">
          <img src="/assets/luma-studio-logo.png" alt="苒光繪誌" />
        </a>

        <button
          type="button"
          class="menu-toggle"
          aria-expanded={open}
          aria-label={open ? '關閉選單' : '開啟選單'}
          onClick={() => setOpen(!open)}
        >
          <span aria-hidden="true">{open ? '✕' : '☰'}</span>
        </button>

        <nav class="site-menu" aria-label="主選單">
          <MenuTree menu={menu} parentId={null} depth={1} />
        </nav>

        <div class="header-actions">
          {settings.headerCtaLabel && settings.headerCtaUrl && (
            <a class="cta" href={settings.headerCtaUrl}>
              {settings.headerCtaLabel}
            </a>
          )}
          {settings.headerShowLogin && (
            <a class="action" href={signedIn ? '/orders' : (loginHref ?? '/orders')}>
              {signedIn ? '我的訂單' : '登入'}
            </a>
          )}
          {settings.headerShowCart && (
            <a
              class="action cart-action"
              href="/cart"
              aria-label={cartCount ? `購物車，${cartCount} 件` : '購物車'}
            >
              <CartGlyph />
              {cartCount ? (
                <span key={cartCount} class="count" aria-hidden="true">
                  {cartCount}
                </span>
              ) : null}
            </a>
          )}
        </div>
      </div>

      {open && <div class="menu-scrim" onClick={() => setOpen(false)} />}
    </header>
  )
}

/**
 * The footer: a wide brand column, with the link columns pushed to the right.
 *
 * The link columns came first and ran left to right with nothing anchoring
 * them — a row of headings starting at the page's left edge reads as the end
 * of the content rather than as the shop signing its name. The mark, the
 * blurb and the copyright give that row something to sit beside.
 *
 * The socials belong up here too: they are the shop's own addresses, not a
 * sixth column of links to pages.
 */
export function SiteFooter({ settings }: { settings: SiteSettings }) {
  const hasContent =
    settings.footerColumns.length > 0 ||
    settings.footerSocials.length > 0 ||
    Boolean(settings.footerBlurb) ||
    Boolean(settings.footerCopyright)
  // A footer holding nothing but a logo is a band of colour that says nothing,
  // so an unconfigured site gets no footer at all rather than an empty one.
  if (!hasContent) return null

  return (
    <footer class={`site-footer colour-${settings.footerColour} text-${settings.footerText}`}>
      <div class="footer-inner">
        <div class="footer-brand">
          <a class="footer-mark" href="/">
            <img src="/assets/luma-studio-logo.png" alt="苒光繪誌" />
          </a>

          {settings.footerBlurb && <p class="footer-blurb">{settings.footerBlurb}</p>}

          {settings.footerSocials.length > 0 && (
            <ul class="footer-socials">
              {settings.footerSocials.map((social) => (
                <li key={social.platform}>
                  <a href={social.url} rel="noopener" aria-label={social.platform}>
                    <SocialIcon platform={social.platform} />
                  </a>
                </li>
              ))}
            </ul>
          )}

          {settings.footerCopyright && <p class="footer-copyright">{settings.footerCopyright}</p>}
        </div>

        {settings.footerColumns.length > 0 && (
          <div class="footer-columns">
            {settings.footerColumns.map((column, index) => (
              // Keyed by position: two columns may legitimately share a title.
              <div class="footer-column" key={index}>
                {column.title && <h2>{column.title}</h2>}
                <ul>
                  {column.links.map((link, linkIndex) => (
                    <li key={linkIndex}>
                      <a href={link.url}>{link.label}</a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </footer>
  )
}
