import type { ComponentChildren } from 'preact'

export function Skeleton({ class: className = '', children }: { class?: string; children?: ComponentChildren }) {
  return <div class={`skeleton ${className}`.trim()} aria-hidden="true">{children}</div>
}
