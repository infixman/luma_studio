import { useState } from 'preact/hooks'

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
            <a class="action cart" href="/cart">
              購物車
              {cartCount ? <span class="count">{cartCount}</span> : null}
            </a>
          )}
        </div>
      </div>
    </header>
  )
}

export function SiteFooter({ settings }: { settings: SiteSettings }) {
  const hasContent =
    settings.footerColumns.length > 0 || settings.footerSocials.length > 0 || Boolean(settings.footerCopyright)
  if (!hasContent) return null

  return (
    <footer class={`site-footer colour-${settings.footerColour} text-${settings.footerText}`}>
      <div class="footer-inner">
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
    </footer>
  )
}
