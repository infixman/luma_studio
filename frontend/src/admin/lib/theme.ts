/**
 * Which theme the back office wears, and how that choice survives a reload.
 *
 * Three states, not two. "System" is a real choice — it means "keep following
 * the machine", and it is the one somebody who has never touched the toggle
 * is already in. Collapsing it into light-or-dark would freeze whichever the
 * system happened to be on at the moment they first clicked.
 *
 * Storing the choice is the whole job here: the colours themselves are in
 * styles/tokens.css, keyed off the `data-theme` attribute this sets.
 */

const KEY = 'luma-admin-theme'

export type ThemeChoice = 'system' | 'light' | 'dark'

function isChoice(value: unknown): value is ThemeChoice {
  return value === 'system' || value === 'light' || value === 'dark'
}

export function readChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(KEY)
    return isChoice(stored) ? stored : 'system'
  } catch {
    // Private modes can refuse storage. Following the system is a working
    // back office; a thrown error on the first paint is not.
    return 'system'
  }
}

/**
 * Put the choice on <html>, where the stylesheet is watching for it.
 *
 * "System" removes the attribute rather than writing a value, because that is
 * exactly what the `:not([data-theme])` guard in tokens.css tests for.
 */
export function applyChoice(choice: ThemeChoice): void {
  if (choice === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', choice)
}

export function saveChoice(choice: ThemeChoice): void {
  applyChoice(choice)
  try {
    localStorage.setItem(KEY, choice)
  } catch {
    /* The theme still applies for this tab; it just will not be remembered. */
  }
}

/** What the page is actually showing, once the system has had its say. */
export function resolved(choice: ThemeChoice): 'light' | 'dark' {
  if (choice !== 'system') return choice
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/**
 * Called before the app renders, so the first paint is already the right
 * colour. Reading storage inside a component would paint light and correct
 * itself a frame later, which is the flash every themed site is judged by.
 */
export function startTheme(): ThemeChoice {
  const choice = readChoice()
  applyChoice(choice)
  return choice
}
