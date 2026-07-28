import type { ComponentChildren, JSX } from 'preact'

import '../styles/admin-nav.css'

/**
 * The back office's navigation, in two levels.
 *
 * It used to be nine tabs in a row. Nine already fills the header and the
 * next one would have wrapped, but the real problem is that a flat row says
 * everything on it is the same kind of thing — and the media library and the
 * shipping table are not.
 *
 * So: a rail of areas, and a list of the pages inside the current one. Each
 * level stays short, and adding a page adds a line to a list rather than a
 * tab to a row that has run out of room.
 *
 * The hrefs carry no /admin segment: every path on this host is administration.
 */

export interface NavPage {
  href: string
  label: string
}

export interface NavArea {
  id: string
  label: string
  icon: JSX.Element
  pages: NavPage[]
}

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': 1.7,
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
} as const

export const areas: NavArea[] = [
  {
    id: 'content',
    label: '內容',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
        <path d="M5 3h9l5 5v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
        <path d="M14 3v5h5M8 13h8M8 17h5" />
      </svg>
    ),
    pages: [
      { href: '/pages', label: '頁面' },
      { href: '/site', label: '站台外框' },
      { href: '/card', label: '名片頁' },
      { href: '/media', label: '媒體庫' },
    ],
  },
  {
    id: 'shop',
    label: '商店',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
        <path d="M3 5h2l2 10h10l2-7H6" />
        <circle cx="9" cy="19" r="1.4" />
        <circle cx="17" cy="19" r="1.4" />
      </svg>
    ),
    pages: [
      { href: '/orders', label: '訂單' },
      { href: '/products', label: '商品' },
      { href: '/shipping', label: '運費' },
      { href: '/customers', label: '會員' },
    ],
  },
  {
    id: 'tools',
    label: '工具',
    icon: (
      <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
        <path d="M7 8V4h10v4M7 18H5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2" />
        <path d="M7 15h10v5H7z" />
      </svg>
    ),
    pages: [{ href: '/ibon', label: 'ibon 列印' }],
  },
]

/* The dashboard is not in an area. It is what the rail's mark leads back to,
   and putting it in a list would make it look like one page among several
   rather than the place you start. */
export const HOME = '/'

/** Which area a page belongs to. An unknown path lands in the first one. */
export function areaOf(href: string): NavArea {
  return areas.find((area) => area.pages.some((page) => page.href === href)) ?? areas[0]!
}

export function labelOf(href: string): string {
  if (href === HOME) return '總覽'
  for (const area of areas) {
    const page = area.pages.find((entry) => entry.href === href)
    if (page) return page.label
  }
  return '後台'
}

export function AreaRail({ current, children }: { current: NavArea; children?: ComponentChildren }) {
  return (
    <nav class="admin-rail" aria-label="管理區域">
      <a class="rail-home" href={HOME} aria-label="總覽">
        <img class="rail-mark" src="/assets/luma-studio-logo.png" alt="Luma Studio 苒光繪誌" />
      </a>
      <ul class="rail-areas">
        {areas.map((area) => (
          <li key={area.id}>
            {/* Straight to the area's first page: an area is a grouping, not
                a destination, so there is nothing to show at the level itself. */}
            <a
              class={area.id === current.id ? 'rail-area current' : 'rail-area'}
              href={area.pages[0]!.href}
              aria-current={area.id === current.id ? 'true' : undefined}
            >
              {area.icon}
              <span class="rail-tip">{area.label}</span>
            </a>
          </li>
        ))}
      </ul>
      <div class="rail-foot">{children}</div>
    </nav>
  )
}

export function AreaPages({ area, current }: { area: NavArea; current: string }) {
  return (
    <nav class="admin-sidebar" aria-label={area.label}>
      <p class="sidebar-title">{area.label}</p>
      <ul class="sidebar-pages">
        {area.pages.map((page) => (
          <li key={page.href}>
            <a
              class={page.href === current ? 'sidebar-page current' : 'sidebar-page'}
              href={page.href}
              aria-current={page.href === current ? 'page' : undefined}
            >
              {page.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}
