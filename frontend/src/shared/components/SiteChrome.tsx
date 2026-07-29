import type { JSX } from 'preact'
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
 * Most appearance values arrive as constrained choices and become class
 * names. Custom colours are the exception: the API has already reduced them
 * to six-digit hex before they reach the inline style.
 */

function children(menu: ResolvedMenuItem[], parentId: string | null): ResolvedMenuItem[] {
  return menu.filter((item) => item.parentId === parentId)
}

function contrastingText(hex: string): string {
  const channel = (start: number) => {
    const raw = hex.slice(start, start + 2)
    const value = Number.parseInt(raw, 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
  return luminance > 0.45 ? '#2b2622' : '#faf7f2'
}

function MenuTree({ menu, parentId, depth }: { menu: ResolvedMenuItem[]; parentId: string | null; depth: number }) {
  const [expanded, setExpanded] = useState<string[]>([])
  const items = children(menu, parentId)
  if (items.length === 0) return null

  return (
    <ul class={`menu-level depth-${depth}`}>
      {items.map((item) => {
        const nested = children(menu, item.id)
        const isParent = item.href === null
        const isExpanded = expanded.includes(item.id)
        return (
          <li
            key={item.id}
            class={[nested.length ? 'has-children' : '', isExpanded ? 'is-open' : ''].filter(Boolean).join(' ')}
          >
            {isParent && nested.length ? (
              <button
                type="button"
                class="menu-parent-label"
                aria-haspopup="true"
                aria-expanded={isExpanded}
                onClick={() =>
                  setExpanded((current) =>
                    current.includes(item.id)
                      ? current.filter((id) => id !== item.id)
                      : [...current, item.id],
                  )
                }
              >
                {item.label}
              </button>
            ) : isParent ? (
              <span class="menu-parent-label">{item.label}</span>
            ) : (
              <a href={item.href ?? undefined}>{item.label}</a>
            )}
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
  const customStyle: JSX.CSSProperties = {
    ...(settings.headerBackground === 'solid' && settings.headerColour === 'custom'
      ? { backgroundColor: settings.headerCustomColour }
      : {}),
    ...(settings.headerText === 'custom' ? { color: settings.headerCustomText } : {}),
  }
  const customBadgeStyle: JSX.CSSProperties | undefined =
    settings.headerText === 'custom'
      ? {
          backgroundColor: settings.headerCustomText,
          color: contrastingText(settings.headerCustomText),
        }
      : undefined

  return (
    <header class={classes} style={customStyle}>
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
                <span key={cartCount} class="count" style={customBadgeStyle} aria-hidden="true">
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

  const customStyle: JSX.CSSProperties = {
    ...(settings.footerColour === 'custom' ? { backgroundColor: settings.footerCustomColour } : {}),
    ...(settings.footerText === 'custom' ? { color: settings.footerCustomText } : {}),
  }

  return (
    <footer
      class={`site-footer colour-${settings.footerColour} text-${settings.footerText}`}
      style={customStyle}
    >
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
                  <a
                    href={social.url}
                    target={social.newTab ? '_blank' : undefined}
                    rel={social.newTab ? 'noopener' : undefined}
                    aria-label={social.platform}
                  >
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
                      <a
                        href={link.url}
                        target={link.newTab ? '_blank' : undefined}
                        rel={link.newTab ? 'noopener' : undefined}
                      >
                        {link.label}
                      </a>
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
