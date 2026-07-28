/**
 * Making the responsive widths of an image, in the browser, before it is sent.
 *
 * The storefront used to hand a phone the same 1024px original the owner
 * uploaded. That is somebody else's data plan, not a matter of taste.
 *
 * It happens here rather than in the Worker for two reasons. There is no
 * Pillow in a Python Cloudflare Worker and Image Resizing is a paid zone
 * feature, so the Worker could not do it; and doing it once at upload time
 * puts the cost on the one person uploading rather than on every customer who
 * loads the page afterwards.
 *
 * The maths is separated from the drawing on purpose. Getting a rounded height
 * wrong is invisible — the picture still appears, slightly squashed — so the
 * part that can be wrong is the part that is a plain function with tests.
 */

import type { MediaSize } from '../../shared/types'

export interface PlannedSize {
  label: MediaSize['label']
  width: number
  height: number
}

/**
 * Roughly a phone, a tablet and a laptop at the densities people actually
 * hold. Named rather than numbered in what is stored, so moving 960 later does
 * not have to rewrite every row.
 */
export const SIZE_TARGETS: { label: MediaSize['label']; width: number }[] = [
  { label: 'small', width: 480 },
  { label: 'medium', width: 960 },
  { label: 'large', width: 1600 },
]

/** webp at this quality is smaller than the JPEG it came from and hard to tell apart. */
export const VARIANT_QUALITY = 0.82

/**
 * Which widths are worth making for an image of this size.
 *
 * Nothing is ever scaled up. A 600px drawing blown up to 1600 is a bigger file
 * that looks worse — it would lose to the original on both counts — so the
 * targets at or above the original are dropped and the original stands in for
 * them in the srcset.
 *
 * An unmeasured image (0) plans nothing: the browser could not decode it, so
 * there is nothing to draw from.
 */
export function planSizes(width: number, height: number): PlannedSize[] {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return []
  return SIZE_TARGETS.filter((target) => target.width < width).map((target) => ({
    label: target.label,
    width: target.width,
    height: scaledHeight(width, height, target.width),
  }))
}

/**
 * The height that keeps the aspect ratio at a given width.
 *
 * Rounded, never to zero. A very wide, very short banner — 2000×3 — rounds to
 * nothing at 480, and a canvas of height 0 throws rather than producing a bad
 * picture, so the floor is one pixel.
 */
export function scaledHeight(width: number, height: number, target: number): number {
  return Math.max(1, Math.round((height * target) / width))
}

export interface RenderedVariant extends PlannedSize {
  blob: Blob
}

export interface PreparedUpload {
  /** The original's pixels, or null when the browser could not decode it. */
  dimensions: { width: number; height: number } | null
  variants: RenderedVariant[]
}

/**
 * Decode the file once, then draw it at each planned width.
 *
 * `imageOrientation: 'from-image'` is also the whole of the EXIF fix. A photo
 * from a phone carries an orientation tag rather than rotated pixels, so it
 * arrives lying on its side; this option makes the browser apply the tag while
 * decoding, and every canvas drawn from the bitmap is therefore the right way
 * up. There is deliberately no separate EXIF code — a second implementation of
 * something the decoder already does is a second thing to get wrong.
 *
 * A failure to decode is not a failure to upload. The owner keeps the original
 * either way; what is lost is the responsive widths, which is a page that
 * loads a larger file than it needed to, not a photo that never got stored.
 */
export async function prepareUpload(file: File): Promise<PreparedUpload> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    return { dimensions: null, variants: [] }
  }

  try {
    const dimensions = { width: bitmap.width, height: bitmap.height }
    const variants: RenderedVariant[] = []
    for (const planned of planSizes(bitmap.width, bitmap.height)) {
      const blob = await drawToWebp(bitmap, planned.width, planned.height)
      // One width that will not encode costs that width. The rest of the set
      // and the original are still worth uploading.
      if (blob) variants.push({ ...planned, blob })
    }
    return { dimensions, variants }
  } finally {
    // The decoded pixels are held outside the JavaScript heap, so a batch of
    // twenty photographs is twenty of these to release rather than to leave
    // for whenever the collector gets round to it.
    bitmap.close()
  }
}

async function drawToWebp(bitmap: ImageBitmap, width: number, height: number): Promise<Blob | null> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return null
  // The browser's own downscaler, asked for its best. The default is a nearest
  // sample, which on a drawing shows up as broken lines.
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(bitmap, 0, 0, width, height)
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', VARIANT_QUALITY))
}

/** How the dimensions travel in the upload form: one field, "1024x768". */
export function dimensionsField(size: { width: number; height: number }): string {
  return `${size.width}x${size.height}`
}
