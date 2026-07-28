/**
 * The browser's memory, and the one naming scheme for it.
 *
 * Storage can throw: private mode, a full quota, a browser that has switched
 * it off. Nothing kept here is worth taking the page down for — a column
 * preference, a theme, a copied block — so every access fails quietly back to
 * the default.
 *
 * Three keys landed on the same day under three schemes:
 * `luma-admin-columns:`, `luma-admin-theme`, `luma.block-clipboard`. Three
 * shapes is how a fourth one gets invented; `key()` is now the only way to
 * name one, so they cannot drift again.
 */

/** Every key this back office owns, so a shared origin stays legible. */
export function key(name: string): string {
  return `luma-admin-${name}`
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** The stored string, or null — including when storage itself is unavailable. */
export function read(name: string): string | null {
  try {
    return storage()?.getItem(key(name)) ?? null
  } catch {
    return null
  }
}

export function write(name: string, value: string): void {
  try {
    storage()?.setItem(key(name), value)
  } catch {
    /* The choice holds for this tab and is simply not remembered. */
  }
}

export function forget(name: string): void {
  try {
    storage()?.removeItem(key(name))
  } catch {
    /* Same: nothing here is worth an error. */
  }
}
