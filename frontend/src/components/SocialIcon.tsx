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
  threads: (
    <>
      <path d="M15.6 8.4C14.7 7.2 13.4 6.6 12 6.6c-3 0-5 2.3-5 5.4s2 5.4 5 5.4c2.6 0 4.2-1.5 4.2-3.2 0-1.6-1.3-2.7-3.4-2.7-1.5 0-2.5.7-2.5 1.7 0 .8.6 1.3 1.5 1.3 1.2 0 1.9-.9 1.9-2.4" />
    </>
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

export function SocialIcon({ platform }: { platform: string | null }) {
  const glyph = glyphs[platform ?? ''] ?? glyphs.website
  return (
    <svg class="social-icon" viewBox="0 0 24 24" aria-hidden="true">
      {glyph}
    </svg>
  )
}
