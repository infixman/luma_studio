import { IconButton } from './ui'

/**
 * The padlock beside a page's path.
 *
 * Shut, the path is the title's shadow and the field is read-only; open, it
 * is the owner's to type and nothing writes it again. One component for both
 * places that draw it — the new-page form and the editor's settings — because
 * the two have to mean the same thing, and a lock whose labels disagree
 * between two screens is a lock nobody trusts.
 *
 * A padlock rather than a checkbox reading "自動產生網址": the state worth
 * showing is whether the field is yours, and that is what a lock says.
 */

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': 1.7,
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
} as const

const shut = (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
    <rect x="5" y="11" width="14" height="9" rx="1.5" />
    <path d="M8 11V7.5a4 4 0 0 1 8 0V11" />
  </svg>
)

/* The shackle swung clear of the body, which is the whole difference — at
   this size a colour change alone is not one. */
const open = (
  <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
    <rect x="5" y="11" width="14" height="9" rx="1.5" />
    <path d="M8 11V7.5a4 4 0 0 1 7.7-1.5" />
  </svg>
)

export function SlugLock({ locked, onChange }: { locked: boolean; onChange: (locked: boolean) => void }) {
  return (
    <IconButton
      label={locked ? '解鎖，改成自己填網址' : '鎖上，讓網址跟著頁面名稱'}
      size="sm"
      class={locked ? 'slug-lock is-locked' : 'slug-lock'}
      onClick={() => onChange(!locked)}
    >
      {locked ? shut : open}
    </IconButton>
  )
}
