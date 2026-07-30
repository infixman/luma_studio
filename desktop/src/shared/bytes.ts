/**
 * A size, in the unit a reader can act on.
 *
 * A finished encode is gigabytes, and `3072.4 MB` is a number the reader has to
 * convert before it means anything. The back office learned this the same way
 * and has its own copy — separate apps, no shared package, and a formatter is
 * cheaper to write twice than a package is to add.
 */
export function fileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}
