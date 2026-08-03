import { useCallback, useEffect, useState } from 'preact/hooks'

import { AdminShell } from '../components/AdminShell'
import { useStatus } from '../components/StatusBar'
import { Button, Panel, Spinner, TextField, Toggle } from '../components/ui'
import { api, apiJson } from '../../shared/api'
import type { ShippingMethod } from '../../shared/types'

/**
 * The numeric fields are held as strings while being edited.
 *
 * An empty threshold box has to mean "never ships free", which is not a
 * number, and a half-typed fee is not one either. Converting on save keeps
 * both out of the model rather than smuggling NaN through it.
 */
type Draft = Omit<ShippingMethod, 'fee' | 'freeThreshold'> & { fee: string; freeThreshold: string }

function toDraft(method: ShippingMethod): Draft {
  return {
    ...method,
    fee: String(method.fee),
    freeThreshold: method.freeThreshold === null ? '' : String(method.freeThreshold),
  }
}

export function ShippingPage() {
  const [drafts, setDrafts] = useState<Draft[] | null>(null)
  const [savedDrafts, setSavedDrafts] = useState<Draft[] | null>(null)
  const { message, showError, busy, run } = useStatus()

  const load = useCallback(async () => {
    try {
      const data = await api<{ methods: ShippingMethod[] }>('/api/shipping-methods')
      const next = data.methods.map(toDraft)
      setDrafts(next)
      setSavedDrafts(next)
    } catch (error) {
      showError(error)
    }
  }, [showError])

  useEffect(() => {
    void load()
  }, [load])

  function edit(method: string, patch: Partial<Draft>) {
    setDrafts((current) => current?.map((draft) => (draft.method === method ? { ...draft, ...patch } : draft)) ?? null)
  }

  function save() {
    if (!drafts) return
    void run(async () => {
      const data = await apiJson<{ methods: ShippingMethod[] }>('/api/shipping-methods', 'PUT', {
        methods: drafts.map((draft) => ({
          method: draft.method,
          label: draft.label,
          enabled: draft.enabled,
          fee: Number.parseInt(draft.fee, 10),
          // An empty box means no free-shipping offer, which is not the same
          // as a threshold of zero — that would make everything ship free.
          freeThreshold: draft.freeThreshold.trim() === '' ? null : Number.parseInt(draft.freeThreshold, 10),
        })),
      })
      const next = data.methods.map(toDraft)
      setDrafts(next)
      setSavedDrafts(next)
    }, '運費已儲存。')
  }

  const dirty = drafts !== null && savedDrafts !== null && JSON.stringify(drafts) !== JSON.stringify(savedDrafts)

  return (
    <AdminShell
      current="/shipping"
      message={message}
      onError={showError}
      actions={
        <Button tone="primary" busy={busy} disabled={!dirty} onClick={save}>
          儲存運費
        </Button>
      }
    >
      {drafts === null ? (
        <Spinner />
      ) : (
        drafts.map((draft) => (
          <Panel key={draft.method} title={draft.label}>
            <Toggle
              label="提供這個配送方式"
              hint={draft.enabled ? undefined : '關掉之後結帳頁不會列出它。'}
              checked={draft.enabled}
              onChange={(enabled) => edit(draft.method, { enabled })}
            />
            <div class="field-pair">
              <TextField
                label="顯示名稱"
                value={draft.label}
                maxLength={40}
                required
                onInput={(event) => edit(draft.method, { label: (event.currentTarget as HTMLInputElement).value })}
              />
              <TextField
                label="運費"
                type="number"
                min={0}
                max={1000}
                step={1}
                value={draft.fee}
                required
                onInput={(event) => edit(draft.method, { fee: (event.currentTarget as HTMLInputElement).value })}
              />
              <TextField
                label="免運門檻"
                type="number"
                min={1}
                max={100000}
                step={1}
                placeholder="留空＝不免運"
                hint="達到這個金額就免運，留空代表這個方式不提供"
                value={draft.freeThreshold}
                onInput={(event) =>
                  edit(draft.method, { freeThreshold: (event.currentTarget as HTMLInputElement).value })
                }
              />
            </div>
          </Panel>
        ))
      )}
    </AdminShell>
  )
}
