export interface PrintResult {
  id: string
  pincode: string
  deadline: string
  qrCodeSvg: string
  files: string[]
  selectType: string
  printSpec: string
  cached: boolean
  cachedAt: number
  cacheExpiresAt: number
}

export interface FolderListing {
  folders: string[]
  truncated: boolean
}

export interface StoredObject {
  key: string
  name: string
  size: number
}

export interface ObjectListing {
  folder: string
  objects: StoredObject[]
  truncated: boolean
}

export type BioLinkKind = 'link' | 'social'

/** An item as the editor sees it. */
export interface BioLinkItem {
  id: string
  kind: BioLinkKind
  title: string
  url: string
  platform: string | null
  enabled: boolean
  // No `position`: the array's order is the page's order, and a second
  // representation of the same thing is one that can disagree with it.
}

/** What the editor loads and every mutation returns. */
export type BioLinkTheme = 'warm' | 'ink' | 'forest' | 'sand' | 'night'
export type BioLinkShape = 'rounded' | 'pill' | 'square'
export type BioLinkFont = 'sans' | 'serif'

export interface BioLinkStyle {
  theme: BioLinkTheme
  buttonShape: BioLinkShape
  fontStyle: BioLinkFont
}

export interface BioLinkEvent {
  id: string
  title: string
  start: string
  end: string
  allDay: boolean
  location: string
  description: string
}

export interface BioLinkState extends BioLinkStyle {
  displayName: string
  bio: string
  avatarPath: string | null
  calendarUrl: string
  calendarTitle: string
  calendarCount: number
  calendarEnabled: boolean
  items: BioLinkItem[]
}

export interface LabelledTotal {
  label: string
  total: number
}

/** Distinct visitors, not raw hits: events are deduped per visitor per day. */
export interface BioLinkStats {
  days: number
  since: string
  views: number
  clicks: number
  daily: { day: string; views: number; clicks: number }[]
  items: { id: string; title: string; total: number }[]
  countries: LabelledTotal[]
  referrers: LabelledTotal[]
  devices: LabelledTotal[]
}

/** The trimmed shape anonymous visitors receive. */
export interface PublicBioLink {
  displayName: string
  bio: string
  avatarPath: string | null
  style: BioLinkStyle
  calendar: { title: string; events: BioLinkEvent[] } | null
  links: { id: string; title: string }[]
  socials: { id: string; title: string; platform: string | null }[]
}

export interface PrintSettingsResponse {
  folder: string
  selectType: string
  printSpec: string
  cacheInvalidated?: boolean
}
