export type BioLinkKind = 'link' | 'social'

export interface BioLinkItem {
  id: string
  kind: BioLinkKind
  title: string
  url: string
  platform: string | null
  enabled: boolean
}

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

export interface BioLinkCalendarData {
  title: string
  events: BioLinkEvent[]
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

export interface PublicBioLink {
  displayName: string
  bio: string
  avatarPath: string | null
  style: BioLinkStyle
  hasCalendar: boolean
  links: { id: string; title: string }[]
  socials: { id: string; title: string; platform: string | null }[]
}
