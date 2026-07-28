import { useCallback, useEffect, useState } from 'preact/hooks'

import { AdminShell } from '../components/AdminShell'
import { useStatus } from '../components/StatusBar'
import { ApiError, api, apiJson, clearLoginAttempt } from '../../shared/api'
import type { ShippingMethod } from '../../shared/types'
import '../styles/admin.css'
import '../styles/shop-admin.css'

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
  const [busy, setBusy] = useState(false)
  const { message, show, showError } = useStatus()

  const load = useCallback(async () => {
    try {
      const data = await api<{ methods: ShippingMethod[] }>('/api/shipping-methods')
      setDrafts(data.methods.map(toDraft))
      clearLoginAttempt()
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) showError(error)
    }
  }, [showError])

  useEffect(() => {
    void load()
  }, [load])

  function edit(method: string, patch: Partial<Draft>) {
    setDrafts((current) => current?.map((draft) => (draft.method === method ? { ...draft, ...patch } : draft)) ?? null)
  }

  async function save(event: Event) {
    event.preventDefault()
    if (!drafts || busy) return
    setBusy(true)
    try {
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
      setDrafts(data.methods.map(toDraft))
      show('運費已儲存。', 'ok')
    } catch (error) {
      showError(error)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AdminShell current="/shipping" message={message} onError={showError}>
      <section class="stack shop">
        <div class="card">
          <h2>配送方式與運費</h2>
          {drafts === null ? (
            <p class="muted">載入中…</p>
          ) : (
            <form class="shipping-form" onSubmit={save}>
              <p class="muted">
                免運門檻留空代表這個方式不提供免運。門檻是「達到就免運」，不是「超過才免運」。
              </p>
              {drafts.map((draft) => (
                <fieldset key={draft.method} class={draft.enabled ? 'method' : 'method off'}>
                  <legend>{draft.label}</legend>
                  <label class="toggle">
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      onChange={(event) => edit(draft.method, { enabled: (event.target as HTMLInputElement).checked })}
                    />
                    提供這個配送方式
                  </label>
                  <label>
                    顯示名稱
                    <input
                      value={draft.label}
                      maxLength={40}
                      required
                      onInput={(event) => edit(draft.method, { label: (event.target as HTMLInputElement).value })}
                    />
                  </label>
                  <label>
                    運費
                    <input
                      type="number"
                      min={0}
                      max={1000}
                      step={1}
                      value={draft.fee}
                      required
                      onInput={(event) => edit(draft.method, { fee: (event.target as HTMLInputElement).value })}
                    />
                  </label>
                  <label>
                    免運門檻
                    <input
                      type="number"
                      min={1}
                      max={100000}
                      step={1}
                      placeholder="留空＝不免運"
                      value={draft.freeThreshold}
                      onInput={(event) =>
                        edit(draft.method, { freeThreshold: (event.target as HTMLInputElement).value })
                      }
                    />
                  </label>
                </fieldset>
              ))}
              <button type="submit" disabled={busy}>
                儲存運費
              </button>
            </form>
          )}
        </div>
      </section>
    </AdminShell>
  )
}
