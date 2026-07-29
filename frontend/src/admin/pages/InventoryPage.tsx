import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

import { AdminShell } from '../components/AdminShell'
import { useStatus } from '../components/StatusBar'
import {
  Badge,
  Button,
  DataTable,
  EmptyState,
  Panel,
  Spinner,
  TextField,
  Toggle,
  Toolbar,
} from '../components/ui'
import type { Column } from '../components/ui'
import { api, apiJson } from '../../shared/api'
import type { InventoryItem } from '../../shared/types'
import '../styles/shop-admin.css'

const EMPTY_DRAFT = { title: '', sku: '', stock: '', enabled: true }

/**
 * The stockroom.
 *
 * This screen exists because a count can belong to more than one offer. A
 * material kit sold on its own and included in two course bundles is one pile
 * of stock; the product editor for any one of those offers cannot say that,
 * so it refuses to edit a shared item and sends the admin here, where the
 * sharing is visible.
 */
export function InventoryPage() {
  const [items, setItems] = useState<InventoryItem[] | null>(null)
  const [search, setSearch] = useState('')
  const [draft, setDraft] = useState(EMPTY_DRAFT)
  const { message, showError, busy, run } = useStatus()

  // Which search the displayed list belongs to. Typing "a" then "ab" leaves
  // two requests in flight, and the slower one is not always the older one;
  // without this the list can settle on results for text already typed past.
  const latest = useRef(0)

  const load = useCallback(
    async (term: string) => {
      const generation = ++latest.current
      try {
        const query = term.trim() ? `?q=${encodeURIComponent(term.trim())}` : ''
        const listing = await api<{ items: InventoryItem[] }>(`/api/inventory-items${query}`)
        if (generation === latest.current) setItems(listing.items)
      } catch (error) {
        if (generation === latest.current) showError(error)
      }
    },
    [showError],
  )

  useEffect(() => {
    void load(search)
  }, [load, search])

  async function create(event: Event) {
    event.preventDefault()
    const ok = await run(async () => {
      await apiJson<{ item: InventoryItem }>('/api/inventory-items', 'POST', {
        title: draft.title.trim(),
        sku: draft.sku.trim(),
        stock: Number.parseInt(draft.stock || '0', 10),
        enabled: draft.enabled,
      })
    }, '庫存品已建立。')

    // Only clear the form once the server has it. Wiping a rejected entry
    // makes the admin retype what they already typed.
    if (ok) {
      setDraft(EMPTY_DRAFT)
      await load(search)
    }
  }

  const columns: Column<InventoryItem>[] = [
    { key: 'title', label: '名稱', render: (item) => item.title },
    {
      key: 'sku',
      label: '貨號',
      // Plenty of things in a stockroom have no code. An empty cell reads as
      // a rendering fault, so say there is nothing rather than show nothing.
      render: (item) => item.sku || '—',
    },
    { key: 'stock', label: '庫存', render: (item) => String(item.stock) },
    {
      key: 'enabled',
      label: '狀態',
      render: (item) =>
        item.enabled ? <Badge tone="success">啟用</Badge> : <Badge tone="neutral">停用</Badge>,
    },
  ]

  const complete = draft.title.trim() !== '' && draft.stock !== ''

  return (
    <AdminShell current="/inventory" message={message} onError={showError}>
      <Panel title="庫存品">
        <p class="muted">
          庫存品是實際會出貨的東西。同一個庫存品可以被多個銷售方案使用，它們共用同一批數量。
        </p>

        <Toolbar>
          <TextField
            label="搜尋"
            type="search"
            placeholder="名稱或貨號"
            value={search}
            onInput={(event) => setSearch((event.currentTarget as HTMLInputElement).value)}
          />
        </Toolbar>

        {items === null ? (
          <Spinner />
        ) : (
          <DataTable
            rows={items}
            columns={columns}
            rowKey={(item) => item.id}
            empty={
              <EmptyState
                title="還沒有庫存品"
                body="建立第一個庫存品，之後就能把它加進商品的銷售方案裡。"
              />
            }
          />
        )}
      </Panel>

      <Panel title="新增庫存品">
        <form class="ui-inline-form" onSubmit={create}>
          <TextField
            label="名稱"
            value={draft.title}
            maxLength={80}
            required
            onInput={(event) => setDraft({ ...draft, title: (event.currentTarget as HTMLInputElement).value })}
          />
          <TextField
            label="貨號"
            hint="選填"
            value={draft.sku}
            maxLength={40}
            onInput={(event) => setDraft({ ...draft, sku: (event.currentTarget as HTMLInputElement).value })}
          />
          <TextField
            label="庫存"
            type="number"
            min={0}
            step={1}
            value={draft.stock}
            required
            onInput={(event) => setDraft({ ...draft, stock: (event.currentTarget as HTMLInputElement).value })}
          />
          <Toggle label="啟用" checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} />
          <Button type="submit" tone="primary" busy={busy} disabled={!complete}>
            新增
          </Button>
        </form>
      </Panel>
    </AdminShell>
  )
}
