import { Checkbox, RadioGroup, TextField } from '../../components/ui'
import { RichTextEditor } from '../../components/RichTextEditor'
import { textToHtml } from '../../lib/rich-text'
import { PRODUCT_SLUG_MAX, PRODUCT_TITLE_MAX } from './constraints'
import type { Category, ProductStatus } from '../../../shared/types'

export interface ProductFormValue {
  title: string
  slug: string
  description: string
  status: ProductStatus
}

const STATUSES: { value: ProductStatus; label: string; hint: string }[] = [
  { value: 'draft', label: '草稿', hint: '只有你看得到' },
  { value: 'active', label: '上架中', hint: '顧客可以看到並購買' },
  { value: 'archived', label: '已下架', hint: '保留紀錄，但不再販售' },
]

/**
 * The fields shared by product creation and editing. Variants and photos only
 * exist after the product has an id, but its customer-facing data should be
 * completed before that first record is created.
 */
export function ProductFormFields({
  value,
  categories,
  chosen,
  onChange,
  onChosenChange,
  slugHint,
}: {
  value: ProductFormValue
  categories: Category[]
  chosen: string[]
  onChange: (next: ProductFormValue) => void
  onChosenChange: (next: string[]) => void
  slugHint?: string
}) {
  return (
    <>
      <div class="product-form-main">
        <div class="product-identity">
          <TextField
            label="商品名稱"
            value={value.title}
            maxLength={PRODUCT_TITLE_MAX}
            required
            onInput={(event) =>
              onChange({ ...value, title: (event.currentTarget as HTMLInputElement).value })
            }
          />
          <TextField
            label="網址代稱"
            hint={
              slugHint ??
              `顧客看到的網址是 /shop/${value.slug || '…'}。只使用英文字母、數字與連字號。`
            }
            value={value.slug}
            maxLength={PRODUCT_SLUG_MAX}
            required
            onInput={(event) =>
              onChange({ ...value, slug: (event.currentTarget as HTMLInputElement).value })
            }
          />
        </div>

        <div class="ui-field">
          <label class="ui-label">商品說明</label>
          <RichTextEditor
            config={{ body: textToHtml(value.description), format: 'html' }}
            onChange={(next) => onChange({ ...value, description: next.body })}
          />
        </div>
      </div>

      <aside class="product-form-side" aria-label="商品分類與狀態">
        <fieldset class="ui-checkbox-set">
          <legend class="ui-label">分類</legend>
          {categories.length === 0 ? (
            <p class="muted">還沒有分類。回到商品清單建立第一個分類。</p>
          ) : (
            categories.map((category) => (
              <Checkbox
                key={category.id}
                label={category.title}
                hint={`/shop/c/${category.slug}`}
                checked={chosen.includes(category.id)}
                onChange={(checked) =>
                  onChosenChange(
                    checked
                      ? [...chosen, category.id]
                      : chosen.filter((categoryId) => categoryId !== category.id),
                  )
                }
              />
            ))
          )}
        </fieldset>

        <RadioGroup
          legend="狀態"
          value={value.status}
          options={STATUSES}
          onChange={(status) => onChange({ ...value, status })}
        />
      </aside>
    </>
  )
}
