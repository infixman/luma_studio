/**
 * The two glyphs this tool needs, inline.
 *
 * Inline rather than an icon font or a package: two shapes are not worth a
 * dependency, and the renderer's CSP allows no remote anything — a webfont would
 * have to be bundled and would still be a bigger decision than this.
 *
 * `currentColor` so they follow the button's state rather than needing a second
 * set for hover and disabled.
 */

const COMMON = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': 1.4,
  'stroke-linecap': 'round' as const,
  'stroke-linejoin': 'round' as const,
  'aria-hidden': true,
}

export function PasteIcon() {
  return (
    <svg {...COMMON}>
      <path d="M5.5 2.5h5v2h-5z" />
      <path d="M4 4h-.5A1.5 1.5 0 0 0 2 5.5v8A1.5 1.5 0 0 0 3.5 15h9a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 12.5 4H12" />
    </svg>
  )
}

export function CopyIcon() {
  return (
    <svg {...COMMON}>
      <rect x="6" y="6" width="8" height="8" rx="1.5" />
      <path d="M10 6V3.5A1.5 1.5 0 0 0 8.5 2H3.5A1.5 1.5 0 0 0 2 3.5v5A1.5 1.5 0 0 0 3.5 10H6" />
    </svg>
  )
}

export function TickIcon() {
  return (
    <svg {...COMMON}>
      <path d="M3 8.5 6.5 12 13 4.5" />
    </svg>
  )
}
