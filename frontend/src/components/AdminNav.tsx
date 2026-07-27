import '../styles/admin-nav.css'

const tabs = [
  { href: '/admin', label: 'ibon 列印' },
  { href: '/admin/bio-link', label: 'Bio Link' },
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
