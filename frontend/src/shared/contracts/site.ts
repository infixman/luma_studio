export type SiteColour = 'cream' | 'sand' | 'clay' | 'forest' | 'ink'
export type SiteTone = 'dark' | 'light'
export type HeaderColour = SiteColour | 'custom'
export type FooterColour = SiteColour | 'custom'
export type FooterTone = SiteTone | 'custom'
export type SiteSize = 'small' | 'medium' | 'large'

export interface SiteSettings {
  headerBackground: 'transparent' | 'solid' | 'image'
  headerColour: HeaderColour
  headerCustomColour: string
  headerImagePath: string | null
  headerHeight: SiteSize
  headerText: SiteTone
  headerLogoSize: SiteSize
  headerSticky: boolean
  headerShowCart: boolean
  headerShowLogin: boolean
  headerCtaLabel: string
  headerCtaUrl: string
  footerColour: FooterColour
  footerText: FooterTone
  footerCustomColour: string
  footerCustomText: string
  footerBlurb: string
  footerCopyright: string
  footerColumns: { title: string; links: { label: string; url: string }[] }[]
  footerSocials: { platform: string; url: string }[]
}

export interface MenuItem {
  id: string
  parentId: string | null
  label: string
  targetKind: 'parent' | 'page' | 'category' | 'url'
  target: string
  position: number
}

export interface MenuState {
  menu: MenuItem[]
  pages: { id: string; title: string; path: string; status: 'draft' | 'published' }[]
  categories: { slug: string; title: string }[]
}

export interface ResolvedMenuItem {
  id: string
  parentId: string | null
  label: string
  href: string | null
}

export interface SiteChrome {
  settings: SiteSettings
  menu: ResolvedMenuItem[]
}
