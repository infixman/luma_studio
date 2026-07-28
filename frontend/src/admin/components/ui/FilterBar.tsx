import { Button, IconButton } from './Button'
import { Select } from './Select'
import { TextField } from './Field'
import {
  OPERATORS,
  defaultOperator,
  defaultValue,
  newRule,
  operatorLabel,
  type FilterField,
  type FilterOperator,
  type FilterRule,
} from './filters'

/**
 * Rows of `[欄位 ▾] [條件 ▾] [值]` that stack, the way Strapi's do.
 *
 * Each row is a control the page already owns — Select, TextField — rather
 * than three bare inputs, so a filter row focuses, types ahead and reads the
 * same as the rest of the back office. Their labels are still there for a
 * screen reader; the stylesheet hides them, because three visible labels per
 * row would be louder than the rows themselves.
 *
 * The rules combine with AND. Said on screen rather than assumed, because a
 * second rule that quietly replaced the first would be worse than either.
 */

interface FilterBarProps {
  fields: FilterField[]
  rules: FilterRule[]
  onChange: (rules: FilterRule[]) => void
}

export function FilterBar({ fields, rules, onChange }: FilterBarProps) {
  const first = fields[0]
  if (!first) return null

  function fieldOf(name: string): FilterField {
    return fields.find((field) => field.name === name) ?? first!
  }

  function patch(id: string, change: Partial<FilterRule>) {
    onChange(rules.map((rule) => (rule.id === id ? { ...rule, ...change } : rule)))
  }

  // Changing the field resets the rest of the row: an operator or a value
  // carried over from another field is a rule that means nothing.
  function changeField(rule: FilterRule, name: string) {
    const field = fieldOf(name)
    patch(rule.id, { field: name, operator: defaultOperator(field), value: defaultValue(field) })
  }

  return (
    <div class="ui-filters">
      {rules.length === 0 && <p class="ui-filters-empty">還沒有篩選條件。加一條來縮小這份清單。</p>}

      {rules.map((rule, index) => {
        const field = fieldOf(rule.field)
        return (
          <div class="ui-filter-row" key={rule.id}>
            <span class="ui-filter-joiner">{index === 0 ? '條件' : '而且'}</span>

            <Select
              label="篩選欄位"
              value={rule.field}
              options={fields.map((option) => ({ value: option.name, label: option.label }))}
              onChange={(name) => changeField(rule, name)}
            />

            <Select<FilterOperator>
              label="比較方式"
              value={rule.operator}
              options={OPERATORS[field.type].map((operator) => ({
                value: operator,
                label: operatorLabel(field.type, operator),
              }))}
              onChange={(operator) => patch(rule.id, { operator })}
            />

            {field.type === 'enum' ? (
              <Select
                label="值"
                value={rule.value || null}
                placeholder="請選擇"
                options={field.options ?? []}
                onChange={(value) => patch(rule.id, { value })}
              />
            ) : (
              <TextField
                label="值"
                type={field.type === 'date' ? 'date' : field.type === 'number' ? 'number' : 'text'}
                value={rule.value}
                onInput={(event) => patch(rule.id, { value: (event.currentTarget as HTMLInputElement).value })}
              />
            )}

            <IconButton
              label={`移除「${field.label}」這條篩選`}
              tone="danger"
              size="sm"
              onClick={() => onChange(rules.filter((other) => other.id !== rule.id))}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </IconButton>
          </div>
        )
      })}

      <div class="ui-filter-actions">
        <Button size="sm" onClick={() => onChange([...rules, newRule(first)])}>
          ＋ 新增篩選
        </Button>
        {rules.length > 0 && (
          <Button size="sm" tone="ghost" onClick={() => onChange([])}>
            清除全部
          </Button>
        )}
      </div>
    </div>
  )
}
