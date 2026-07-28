import { useState } from 'preact/hooks'

import { readChoice, resolved, saveChoice, type ThemeChoice } from '../lib/theme'

/**
 * Cycles system → light → dark → system.
 *
 * A cycle rather than a two-state switch because "follow the system" is a
 * real setting, and it is the one every new visitor is already in. A switch
 * would silently take that away the first time anybody touched it.
 *
 * The icon shows what is on screen now; the label says what the setting is,
 * which are different sentences when the setting is "system".
 */

const NEXT: Record<ThemeChoice, ThemeChoice> = { system: 'light', light: 'dark', dark: 'system' }
const NAMES: Record<ThemeChoice, string> = { system: '跟隨系統', light: '淺色', dark: '深色' }

export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>(readChoice)

  function cycle() {
    const next = NEXT[choice]
    saveChoice(next)
    setChoice(next)
  }

  const showing = resolved(choice)

  return (
    <button
      type="button"
      class="rail-button"
      onClick={cycle}
      aria-label={`外觀：${NAMES[choice]}。點一下切換到${NAMES[NEXT[choice]]}`}
      title={`外觀：${NAMES[choice]}`}
    >
      {choice === 'system' ? <AutoIcon /> : showing === 'dark' ? <MoonIcon /> : <SunIcon />}
      <span class="rail-tip">外觀：{NAMES[choice]}</span>
    </button>
  )
}

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': 1.7,
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
} as const

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
    </svg>
  )
}

function AutoIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <circle cx="12" cy="12" r="8.5" />
      {/* Half filled: the setting is "whichever the machine says". */}
      <path d="M12 3.5a8.5 8.5 0 0 1 0 17Z" fill="currentColor" stroke="none" />
    </svg>
  )
}
