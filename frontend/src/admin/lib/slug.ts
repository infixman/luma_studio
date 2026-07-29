/**
 * The address a page lives at, and whether it is still the title's shadow.
 *
 * The path used to be suggested exactly once — when the page was created —
 * and never again, so renaming a page left the address saying what the page
 * used to be called. The fix is not "always follow": an address that has been
 * handed out must not move because somebody fixed a typo in the title. So it
 * is a lock, the way Payload does it. Locked, the path is derived and the
 * field is read-only. Unlocked, it is the owner's to type and nothing touches
 * it again.
 */

/** Turns text into an ASCII slug. Feature helpers add their own URL shape. */
export function slugifyAscii(value: string, maxLength?: number): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return maxLength === undefined ? slug : slug.slice(0, maxLength).replace(/-+$/g, '')
}

/** Turns a title into a path: latin letters and digits, which is what a URL should carry. */
export function suggestPath(title: string): string {
  const slug = slugifyAscii(title)
  return slug ? `/${slug}` : ''
}

/**
 * What the path should become now that the title has changed.
 *
 * A title holding nothing a URL can carry — which most of this shop's titles
 * are, being Chinese — suggests nothing, and nothing must not overwrite a
 * path that works. An empty suggestion therefore leaves the current value
 * alone rather than emptying the field under the owner's hands.
 */
export function nextPath(current: string, title: string, locked: boolean): string {
  if (!locked) return current
  return suggestPath(title) || current
}

/**
 * Whether a stored path still looks like it came from the title.
 *
 * This is how an already-saved page decides whether its lock starts shut or
 * open. A path that was typed by hand — `/about` under a Chinese title — has
 * to start unlocked, because otherwise the first keystroke in the title box
 * would move a published address.
 */
export function followsTitle(title: string, path: string): boolean {
  const suggested = suggestPath(title)
  return suggested !== '' && suggested === path
}
