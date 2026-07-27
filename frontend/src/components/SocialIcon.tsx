import type { JSX } from 'preact'

/**
 * Simplified single-colour glyphs rather than official brand marks: they stay
 * legible at 22px, render in one colour, and carry no trademark baggage. The
 * accessible name always spells the platform out.
 */
const glyphs: Record<string, JSX.Element> = {
  instagram: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17" cy="7" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  facebook: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <path d="M14.5 8.5h-1.2a1.3 1.3 0 0 0-1.3 1.3V12m-1.6 0h3.3M12 12v5" />
    </>
  ),
  // The official mark, from simple-icons (icon files are CC0; the trademark
  // stays with Meta, and linking to a platform with its own logo is the
  // ordinary use). Solid rather than stroked, hence `filledGlyphs` below.
  threads: (
    <path d="M18.263 11.097c-.03-3.486-1.92-5.586-5.111-5.586-2.13 0-3.922.963-4.863 2.499l2.062 1.438c.535-.843 1.272-1.543 2.628-1.543 1.528 0 2.318.85 2.544 2.431a15 15 0 0 0-2.236-.173c-4.125 0-6.068 1.867-6.068 4.336s1.943 3.99 4.804 3.99c3.139 0 5.013-2.115 5.781-4.735.798.361 1.348 1.204 1.348 2.47 0 3.387-3.907 5.232-7.22 5.232-4.885 0-8.077-3.207-8.077-8.424 0-6.392 4.223-10.487 9.9-10.487 3.808 0 5.69 1.671 6.97 3.914l2.108-1.475C21.44 2.078 18.331 0 13.663 0 6.227 0 1.168 5.277 1.168 12.934c0 7 4.953 11.066 10.856 11.066 4.878 0 9.809-2.846 9.809-7.716 0-2.545-1.46-4.231-3.569-5.187m-6.33 4.855c-1.077 0-2.026-.512-2.026-1.453 0-1.483 1.822-1.934 3.606-1.934.678 0 1.34.045 1.927.173-.422 1.927-1.671 3.215-3.508 3.214Z" />
  ),
  youtube: (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="4" />
      <path d="m10.5 9.5 4.5 2.5-4.5 2.5z" />
    </>
  ),
  x: <path d="m5 5 14 14M19 5 5 19" />,
  tiktok: (
    <>
      <path d="M14 4v9.5a3.5 3.5 0 1 1-3.5-3.5" />
      <path d="M14 4c.4 2.2 1.8 3.5 4 3.7" />
    </>
  ),
  line: (
    <>
      <path d="M21 10.6c0 3.7-4 6.7-9 6.7-.7 0-1.4-.1-2-.2L6 20v-3.2C4.2 15.6 3 13.3 3 10.6 3 6.9 7 4 12 4s9 2.9 9 6.6Z" />
    </>
  ),
  pixnet: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.5 16V8.6h2.9a2.3 2.3 0 0 1 0 4.6H9.5" />
    </>
  ),
  email: (
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="2.5" />
      <path d="m4 7 8 6 8-6" />
    </>
  ),
  website: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.2 2.4 3.3 5.3 3.3 8.5S14.2 18.1 12 20.5c-2.2-2.4-3.3-5.3-3.3-8.5S9.8 5.9 12 3.5Z" />
    </>
  ),
}

export const socialPlatforms = [
  { value: 'instagram', label: 'Instagram' },
  { value: 'facebook', label: 'Facebook' },
  { value: 'threads', label: 'Threads' },
  { value: 'youtube', label: 'YouTube' },
  { value: 'x', label: 'X' },
  { value: 'tiktok', label: 'TikTok' },
  { value: 'line', label: 'LINE' },
  { value: 'pixnet', label: '痞客邦' },
  { value: 'email', label: 'Email' },
  { value: 'website', label: '網站' },
] as const

export function platformLabel(platform: string | null): string {
  return socialPlatforms.find((item) => item.value === platform)?.label ?? '連結'
}

/** Official brand paths are solid; the drawn ones are strokes. */
const filledGlyphs = new Set(['threads'])

export function SocialIcon({ platform }: { platform: string | null }) {
  const key = platform ?? ''
  const glyph = glyphs[key] ?? glyphs.website
  const filled = glyph === glyphs[key] && filledGlyphs.has(key)
  return (
    <svg class={filled ? 'social-icon filled' : 'social-icon'} viewBox="0 0 24 24" aria-hidden="true">
      {glyph}
    </svg>
  )
}
