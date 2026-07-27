import '../styles/admin-nav.css'

const tabs = [
  { href: '/', label: 'ibon 列印' },
  { href: '/bio-link', label: 'Bio Link' },
  { href: '/products', label: '商城' },
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
