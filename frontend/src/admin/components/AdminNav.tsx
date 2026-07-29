import { useState } from 'preact/hooks'
import type { ComponentChildren, JSX } from 'preact'

import { read, write } from '../lib/storage'
import { routeById, routeForPath } from '../routes'
import '../styles/admin-nav.css'

/**
 * The back office's navigation: one column of groups that fold open.
 *
 * It was two columns — a rail of icons, and a list of the pages inside
 * whichever one was current. Two columns cost 288px to show four words, and
 * the pages outside the current group were not merely collapsed but invisible:
 * you could not see that 運費 existed without first guessing it lived behind
 * the cart.
 *
 * An accordion shows every group at once and the pages of the ones you have
 * open. Which are open is remembered, and the group holding the current page
 * is opened whether or not it was.
 *
 * Every entry has an icon, leaves included. A group whose header has one and
 * whose children do not reads as two different kinds of list stacked together.
 *
 * The hrefs carry no /admin segment: every path on this host is administration.
 */

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': 1.7,
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
} as const

/* --- icons ---------------------------------------------------------------

   Drawn as glyphs rather than as frames with something inside them: a column
   of same-sized rounded rectangles reads as one shape repeated, and whatever
   is inside them is left doing the telling-apart at 18px. */

const icons = {
  overview: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" />
    </svg>
  ),
  globe: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z" />
    </svg>
  ),
  page: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M14 3v4h4M8.5 13h7M8.5 17h4" />
    </svg>
  ),
  /* A bar top and bottom with the page's own lines between them: a header and
     a footer, without an outline drawn around the whole thing. */
  chrome: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M3 5h18M3 19h18" />
      <path d="M7 10h10M7 14h6" opacity="0.55" />
    </svg>
  ),
  image: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M3 18.5 8.6 11l4.2 5 2.8-3.2L21 20" />
      <circle cx="7.8" cy="7.2" r="1.9" />
    </svg>
  ),
  cart: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M3 5h2l2 10h10l2-7H6" />
      <circle cx="9" cy="19" r="1.4" />
      <circle cx="17" cy="19" r="1.4" />
    </svg>
  ),
  /* A receipt. The torn bottom edge is what makes it an order rather than a
     list of lines. */
  receipt: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M6 3h12v18l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4L6 21Z" />
      <path d="M9.5 8h5M9.5 12h5" />
    </svg>
  ),
  tag: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M11.5 3H20a1 1 0 0 1 1 1v8.5a1 1 0 0 1-.3.7l-8 8a1 1 0 0 1-1.4 0l-8-8a1 1 0 0 1 0-1.4l8-8a1 1 0 0 1 .7-.3Z" />
      <circle cx="16.4" cy="7.6" r="1.4" />
    </svg>
  ),
  box: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="m4 7 8-4 8 4v10l-8 4-8-4Z" />
      <path d="m4 7 8 4 8-4M12 11v10" />
    </svg>
  ),
  truck: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M2.5 6.5h10.5v9H2.5zM13 10h4l4 3.5v2H13" />
      <circle cx="7" cy="18" r="1.6" />
      <circle cx="17.5" cy="18" r="1.6" />
    </svg>
  ),
  people: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <circle cx="9.5" cy="8" r="3.2" />
      <path d="M3 20c0-3.3 2.9-5.5 6.5-5.5S16 16.7 16 20" />
      <path d="M17 5.6a3.2 3.2 0 0 1 0 6M18.4 14.9c1.7.8 2.6 2.4 2.6 5.1" opacity="0.6" />
    </svg>
  ),
  /* A wrench, not a printer. The group holds the ibon tool and the name card,
     and naming a group after one of the two things in it is how the other one
     stops being findable. */
  wrench: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M15.4 3.6a5.5 5.5 0 0 0-6.6 7L3.9 15.5a2 2 0 0 0 0 2.8l1.8 1.8a2 2 0 0 0 2.8 0l4.9-4.9a5.5 5.5 0 0 0 7-6.6l-3 3-2.9-.6-.6-2.9Z" />
    </svg>
  ),
  printer: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M7 8V4h10v4M7 18H5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2" />
      <path d="M7 15h10v5H7z" />
    </svg>
  ),
  /* The name card is a page of links, so: a link. A card would be one more
     rounded rectangle in a column of them. */
  link: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M10 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.6 1.6" />
      <path d="M14 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.6-1.6" />
    </svg>
  ),
  chevron: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  ),
} as const

export interface NavItem {
  href: string
  label: string
  icon: JSX.Element
}

export interface NavGroup {
  id: string
  label: string
  icon: JSX.Element
  /** A group with no children is a link in its own right — 會員 is one. */
  href?: string
  items?: NavItem[]
}

export const groups: NavGroup[] = [
  {
    id: 'dashboard',
    label: routeById('dashboard').label,
    icon: icons.overview,
    href: routeById('dashboard').path,
  },
  {
    id: 'site',
    label: '官網',
    icon: icons.globe,
    items: [
      { href: routeById('pages').path, label: routeById('pages').label, icon: icons.page },
      { href: routeById('site').path, label: routeById('site').label, icon: icons.chrome },
      { href: routeById('media').path, label: routeById('media').label, icon: icons.image },
    ],
  },
  {
    id: 'shop',
    label: '商城',
    icon: icons.cart,
    items: [
      { href: routeById('orders').path, label: routeById('orders').label, icon: icons.receipt },
      { href: routeById('products').path, label: routeById('products').label, icon: icons.box },
      { href: routeById('categories').path, label: routeById('categories').label, icon: icons.tag },
      { href: routeById('shipping').path, label: routeById('shipping').label, icon: icons.truck },
    ],
  },
  { id: 'customers', label: routeById('customers').label, icon: icons.people, href: routeById('customers').path },
  {
    id: 'tools',
    label: '工具',
    icon: icons.wrench,
    items: [
      { href: routeById('ibon').path, label: routeById('ibon').label, icon: icons.printer },
      { href: routeById('card').path, label: routeById('card').label, icon: icons.link },
    ],
  },
]

/** Which navigation row or group owns a page. */
export function groupOf(href: string): NavGroup | null {
  return groups.find((group) => group.href === href || group.items?.some((item) => item.href === href)) ?? null
}

export function labelOf(href: string): string {
  const route = routeForPath(href)
  if (route) return route.label
  for (const group of groups) {
    if (group.href === href) return group.label
    const item = group.items?.find((entry) => entry.href === href)
    if (item) return item.label
  }
  return '後台'
}

const OPEN_KEY = 'nav-open'

function readOpen(current: string): string[] {
  const remembered = read(OPEN_KEY)?.split(',').filter(Boolean) ?? []
  const here = groupOf(current)
  // The group holding the current page opens whether or not it was left that
  // way. A sidebar with nothing marked on it does not say where you are,
  // which is most of what a sidebar is for.
  return here?.items && !remembered.includes(here.id) ? [...remembered, here.id] : remembered
}

export function AdminSidebar({
  current,
  children,
}: {
  current: string
  /** The foot: theme, who is signed in, and the way out. */
  children?: ComponentChildren
}) {
  const [open, setOpen] = useState<string[]>(() => readOpen(current))

  function toggle(id: string) {
    const next = open.includes(id) ? open.filter((entry) => entry !== id) : [...open, id]
    setOpen(next)
    write(OPEN_KEY, next.join(','))
  }

  return (
    <nav class="admin-sidebar" aria-label="管理選單">
      <div class="sidebar-brand">
        <img class="sidebar-mark" src="/assets/luma-studio-logo.png" alt="Luma Studio 苒光繪誌" />
      </div>

      <ul class="nav-groups">
        {groups.map((group) =>
          group.items ? (
            <li key={group.id}>
              <button
                type="button"
                class="nav-group"
                aria-expanded={open.includes(group.id)}
                // Names the list this opens, so a screen reader can say what
                // is about to appear rather than only "expanded".
                aria-controls={`nav-${group.id}`}
                onClick={() => toggle(group.id)}
              >
                <span class="nav-icon">{group.icon}</span>
                <span class="nav-label">{group.label}</span>
                <span class={open.includes(group.id) ? 'nav-chevron is-open' : 'nav-chevron'}>{icons.chevron}</span>
              </button>
              {/* Removed rather than hidden: a link nobody can see but the tab
                  key can still reach is a worse accordion than none. */}
              {open.includes(group.id) && (
                <ul class="nav-items" id={`nav-${group.id}`}>
                  {group.items.map((item) => (
                    <li key={item.href}>
                      <a
                        class={item.href === current ? 'nav-item current' : 'nav-item'}
                        href={item.href}
                        aria-current={item.href === current ? 'page' : undefined}
                      >
                        <span class="nav-icon">{item.icon}</span>
                        <span class="nav-label">{item.label}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ) : (
            <li key={group.id}>
              <a
                class={group.href === current ? 'nav-group is-link current' : 'nav-group is-link'}
                href={group.href}
                aria-current={group.href === current ? 'page' : undefined}
              >
                <span class="nav-icon">{group.icon}</span>
                <span class="nav-label">{group.label}</span>
              </a>
            </li>
          ),
        )}
      </ul>

      <div class="sidebar-foot">{children}</div>
    </nav>
  )
}
