import { Button } from './ui'

/**
 * The padlock beside a page's path.
 *
 * Shut, the path is the title's shadow and the field is read-only; open, it
 * is the owner's to type and nothing writes it again. One component for both
 * places that draw it — the new-page form and the editor's settings — because
 * the two have to mean the same thing, and a lock whose labels disagree
 * between two screens is a lock nobody trusts.
 *
 * The lock state is paired with a plain-language action. A padlock alone is
 * easy to miss beside a disabled field, while "手動輸入" says what the next
 * click will do.
 */

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': 1.7,
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
} as const

const automatic = (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
    <rect x="5" y="11" width="14" height="9" rx="1.5" />
    <path d="M8 11V7.5a4 4 0 0 1 8 0V11" />
  </svg>
)

const manual = (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
    <path d="M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16v4Z" />
    <path d="m13.5 6.5 4 4" />
  </svg>
)

export function SlugLock({ locked, onChange }: { locked: boolean; onChange: (locked: boolean) => void }) {
  const label = locked ? '手動輸入' : '自動產生'

  return (
    <Button
      aria-label={locked ? '改成手動輸入網址' : '改成依頁面名稱自動產生網址'}
      size="sm"
      tone="neutral"
      class={locked ? 'slug-lock is-automatic' : 'slug-lock is-manual'}
      icon={locked ? manual : automatic}
      aria-pressed={!locked}
      onClick={() => onChange(!locked)}
    >
      {label}
    </Button>
  )
}
