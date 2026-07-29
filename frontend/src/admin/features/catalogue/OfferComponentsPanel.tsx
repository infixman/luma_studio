import { useCallback, useEffect, useMemo, useState } from 'preact/hooks'

import { useStatus } from '../../components/StatusBar'
import { Badge, Button, EmptyState, IconButton, Panel, Select, Spinner, TextField } from '../../components/ui'
import { api, apiJson } from '../../../shared/api'
import type {
  Course,
  InventoryItem,
  OfferComponent,
  OfferComponentType,
  OfferComponentsView,
} from '../../../shared/types'

/**
 * What one offer delivers.
 *
 * The list is replaced as a whole rather than edited row by row. A request
 * that adds the kit and fails leaves an offer holding only the course, which
 * is a product nobody meant to sell; sending the whole set means a failed save
 * changes nothing.
 *
 * Nothing here works out whether the offer needs posting. The server derives
 * that from the same components and returns it, so the panel shows one answer
 * instead of computing a second one that can disagree.
 */
export function OfferComponentsPanel({ offerId }: { offerId: string }) {
  const [state, setState] = useState<OfferComponentsView | null>(null)
  const [courses, setCourses] = useState<Course[]>([])
  const [items, setItems] = useState<InventoryItem[]>([])
  const [adding, setAdding] = useState<OfferComponentType>('course')
  const [target, setTarget] = useState('')
  const { message, showError, busy, run } = useStatus()

  const load = useCallback(async () => {
    try {
      const [view, courseList, itemList] = await Promise.all([
        api<OfferComponentsView>(`/api/offers/${encodeURIComponent(offerId)}/components`),
        api<{ courses: Course[] }>('/api/courses'),
        api<{ items: InventoryItem[] }>('/api/inventory-items?enabled=1'),
      ])
      setState(view)
      setCourses(courseList.courses)
      setItems(itemList.items)
    } catch (error) {
      showError(error)
    }
  }, [offerId, showError])

  useEffect(() => {
    void load()
  }, [load])

  const chosen = useMemo(
    () => new Set((state?.components ?? []).map((component) => `${component.type}:${component.componentId}`)),
    [state],
  )

  // A target already in the offer is left out of the picker entirely. Wanting
  // two of something is a quantity; the server refuses a duplicate outright,
  // so offering one would only produce an error the admin cannot act on.
  const available = adding === 'course'
    ? courses.filter((course) => !chosen.has(`course:${course.id}`)).map((course) => ({
        value: course.id,
        label: course.status === 'published' ? course.title : `${course.title}（草稿）`,
      }))
    : items.filter((item) => !chosen.has(`inventory:${item.id}`)).map((item) => ({
        value: item.id,
        label: item.sku ? `${item.title}（${item.sku}）` : item.title,
      }))

  async function save(components: OfferComponent[], note: string) {
    const ok = await run(async () => {
      setState(
        await apiJson<OfferComponentsView>(
          `/api/offers/${encodeURIComponent(offerId)}/components`,
          'PUT',
          {
            components: components.map((component) => ({
              type: component.type,
              componentId: component.componentId,
              quantity: component.quantity,
              accessDays: component.accessDays,
            })),
          },
        ),
      )
    }, note)
    if (ok) setTarget('')
    return ok
  }

  function add(event: Event) {
    event.preventDefault()
    if (!state || !target) return
    void save(
      [
        ...state.components,
        {
          id: '',
          offerId,
          type: adding,
          componentId: target,
          quantity: 1,
          accessDays: null,
          position: state.components.length,
        },
      ],
      '商品內容已更新。',
    )
  }

  function remove(component: OfferComponent) {
    if (!state) return
    void save(
      state.components.filter((existing) => existing.id !== component.id),
      '已移除。',
    )
  }

  function setQuantity(component: OfferComponent, quantity: number) {
    if (!state) return
    void save(
      state.components.map((existing) =>
        existing.id === component.id ? { ...existing, quantity } : existing,
      ),
      '數量已更新。',
    )
  }

  function nameOf(component: OfferComponent): string {
    if (component.type === 'course') {
      return courses.find((course) => course.id === component.componentId)?.title ?? component.componentId
    }
    return items.find((item) => item.id === component.componentId)?.title ?? component.componentId
  }

  if (state === null) {
    return (
      <Panel title="商品內容">
        <Spinner />
      </Panel>
    )
  }

  const { capabilities } = state

  return (
    <Panel title="商品內容">
      {message && <p class="muted">{message.text}</p>}

      <p class="muted">
        這個方案付款後實際會給顧客什麼。
        {capabilities.requiresShipping ? '需要配送。' : capabilities.containsCourse ? '不需配送。' : ''}
        {capabilities.containsCourse ? '付款後立即開通課程。' : ''}
      </p>

      {state.blockers.length > 0 && (
        <ul class="offer-component-blockers">
          {/* Keyed by position: an offer with three unpublished courses gets
              three blockers that all say `course_not_published`. */}
          {state.blockers.map((blocker, index) => (
            <li key={`${blocker.reason}-${index}`}>{blocker.message}</li>
          ))}
        </ul>
      )}

      {state.components.length === 0 ? (
        <EmptyState
          title="還沒有設定內容"
          body="加入課程或實體品，顧客付款後才知道要給什麼。"
          compact
        />
      ) : (
        <ul class="offer-component-list">
          {state.components.map((component) => (
            <li key={component.id}>
              <Badge tone={component.type === 'course' ? 'info' : 'neutral'}>
                {component.type === 'course' ? '線上課程' : '實體商品'}
              </Badge>
              <span class="offer-component-name">{nameOf(component)}</span>
              {component.type === 'course' ? (
                <span class="muted">
                  {/* "30 days from purchase" and "30 days from first viewing"
                      are different products. The server means the second. */}
                  觀看期限：{component.accessDays === null ? '永久' : `觀看後 ${component.accessDays} 天`}
                </span>
              ) : (
                <TextField
                  label="數量"
                  type="number"
                  min={1}
                  step={1}
                  value={component.quantity}
                  // `change`, not `input`. Saving per keystroke sends
                  // quantity=1 on the way to 12, and sends NaN the moment the
                  // field is cleared to retype it.
                  onChange={(event) => {
                    const typed = Number.parseInt((event.currentTarget as HTMLInputElement).value, 10)
                    if (Number.isNaN(typed) || typed < 1) return
                    setQuantity(component, typed)
                  }}
                />
              )}
              <IconButton
                label={`移除「${nameOf(component)}」`}
                size="sm"
                onClick={() => remove(component)}
              >
                ×
              </IconButton>
            </li>
          ))}
        </ul>
      )}

      <form class="ui-inline-form" onSubmit={add}>
        <Select
          label="類型"
          value={adding}
          options={[
            { value: 'course', label: '線上課程' },
            { value: 'inventory', label: '實體商品' },
          ]}
          onChange={(value) => {
            setAdding(value as OfferComponentType)
            setTarget('')
          }}
        />
        <Select
          label="加入"
          value={target}
          options={[{ value: '', label: '請選擇' }, ...available]}
          onChange={setTarget}
        />
        <Button type="submit" tone="primary" busy={busy} disabled={!target}>
          加入
        </Button>
      </form>
    </Panel>
  )
}
