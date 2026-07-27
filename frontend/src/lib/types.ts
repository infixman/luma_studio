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
  position: number
  enabled: boolean
}

/** What the editor loads and every mutation returns. */
export interface BioLinkState {
  displayName: string
  bio: string
  avatarPath: string | null
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
  links: { id: string; title: string }[]
  socials: { id: string; title: string; platform: string | null }[]
}

export interface PrintSettingsResponse {
  folder: string
  selectType: string
  printSpec: string
  cacheInvalidated?: boolean
}
