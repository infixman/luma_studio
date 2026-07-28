import '../styles/admin-nav.css'

/**
 * Ordered by how often the owner reaches for it, not by when it was built.
 * The hrefs carry no /admin segment: every path on this host is administration.
 */
const tabs = [
  { href: '/card', label: '名片頁' },
  { href: '/pages', label: '頁面' },
  { href: '/', label: 'ibon 列印' },
  { href: '/products', label: '商城' },
  { href: '/shipping', label: '運費' },
]

export function AdminNav({ current }: { current: string }) {
  return (
    <nav class="admin-nav" aria-label="管理區域">
      {tabs.map((tab) => (
        <a key={tab.href} class={tab.href === current ? 'admin-tab current' : 'admin-tab'} href={tab.href} aria-current={tab.href === current ? 'page' : undefined}>
          {tab.label}
        </a>
      ))}
    </nav>
  )
}
