import { apiUrl } from './api'
import type { MediaSize } from './types'

/**
 * The `srcset` for a picture the library made narrower copies of.
 *
 * Shared rather than living beside the back office's own helpers, because the
 * storefront is where it matters: the back office looks at these images on a
 * desk, and the customer looks at them on a phone over mobile data.
 *
 * The original is always the last entry. The stored widths stop below the
 * original's own, so without it a large screen would be handed the 1600px
 * copy of a 4000px scan and nothing wider would exist to ask for.
 *
 * An image with no stored widths returns an empty string rather than a
 * one-entry srcset, because one entry is what `src` already said. Every
 * picture uploaded before the widths existed is in that case, and it renders
 * from the original exactly as it did before.
 */
export function srcSetFor(image: { path: string; width?: number; sizes?: MediaSize[] }): string | undefined {
  const sizes = image.sizes ?? []
  if (sizes.length === 0) return undefined
  const entries = sizes.map((size) => `${apiUrl(size.path)} ${size.width}w`)
  if (image.width) entries.push(`${apiUrl(image.path)} ${image.width}w`)
  return entries.join(', ')
}
