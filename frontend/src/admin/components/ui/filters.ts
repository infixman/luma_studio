/**
 * Stackable filters, modelled on Strapi's `[field ▾] [operator ▾] [value]`.
 *
 * The rules are data, not a rendered form: the same list can be handed to
 * `applyFilters` in the browser or turned into query parameters for a list the
 * server has to narrow. Which of the two a page uses is a decision about
 * whether the list it holds is the whole list — see the comment on each page.
 *
 * Rules combine with AND, the way Strapi's do. Two rules that cannot both hold
 * therefore produce nothing, and that is honest: the page says "no matches"
 * and offers a way back rather than quietly dropping one of them.
 *
 * Nothing here touches the DOM, so it is all testable.
 */

export type FilterFieldType = 'enum' | 'text' | 'number' | 'date'

export type FilterOperator = 'eq' | 'ne' | 'contains' | 'gte' | 'lte'

export interface FilterField {
  name: string
  label: string
  type: FilterFieldType
  /** `enum` only: what the value dropdown offers. */
  options?: { value: string; label: string }[]
}

export interface FilterRule {
  /** Its own identity, so two rules on the same field stay apart while edited. */
  id: string
  field: string
  operator: FilterOperator
  value: string
}

/**
 * Which operators a field type gets.
 *
 * Deliberately short. An operator list that covers every case is a list nobody
 * reads; these are the comparisons a shop actually makes.
 */
export const OPERATORS: Record<FilterFieldType, FilterOperator[]> = {
  enum: ['eq', 'ne'],
  text: ['contains', 'eq', 'ne'],
  number: ['eq', 'gte', 'lte'],
  date: ['gte', 'lte'],
}

/**
 * The same operator reads differently on a date than on a number: "大於或等於
 * 2026-07-01" is a sentence nobody says out loud.
 */
const OPERATOR_LABELS: Record<FilterFieldType, Partial<Record<FilterOperator, string>>> = {
  enum: { eq: '是', ne: '不是' },
  text: { contains: '包含', eq: '等於', ne: '不等於' },
  number: { eq: '等於', gte: '大於或等於', lte: '小於或等於' },
  date: { gte: '在這天之後（含當天）', lte: '在這天之前（含當天）' },
}

export function operatorLabel(type: FilterFieldType, operator: FilterOperator): string {
  return OPERATOR_LABELS[type][operator] ?? operator
}

/** The first operator of a field's type — what a freshly added rule starts on. */
export function defaultOperator(field: FilterField): FilterOperator {
  return OPERATORS[field.type][0] ?? 'eq'
}

/** The value a freshly added rule starts on: the first option, or nothing. */
export function defaultValue(field: FilterField): string {
  return field.type === 'enum' ? (field.options?.[0]?.value ?? '') : ''
}

let counter = 0

export function newRule(field: FilterField): FilterRule {
  counter += 1
  return {
    id: `rule-${counter}`,
    field: field.name,
    operator: defaultOperator(field),
    value: defaultValue(field),
  }
}

/* --- dates ------------------------------------------------------------- */

/**
 * A `YYYY-MM-DD` from a date input, as the seconds that bound that whole day
 * **in the reader's own timezone**.
 *
 * Parsed by hand rather than through `new Date(iso)`, which reads a bare date
 * as UTC — off by eight hours here, which is enough to drop an order placed
 * late in the evening out of a range that visibly includes its date.
 */
export function dayStart(iso: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim())
  if (!match) return null
  const [, year, month, day] = match
  const at = new Date(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0)
  return Number.isNaN(at.getTime()) ? null : Math.floor(at.getTime() / 1000)
}

/** The last second of that day, so "之前（含當天）" really includes it. */
export function dayEnd(iso: string): number | null {
  const start = dayStart(iso)
  return start === null ? null : start + 24 * 60 * 60 - 1
}

/* --- matching ---------------------------------------------------------- */

/**
 * Does one value satisfy one rule?
 *
 * A rule with no value yet is skipped rather than treated as "matches
 * nothing": clicking "新增篩選" would otherwise empty the list before anyone
 * had said what to filter by.
 *
 * An array value — a product's categories — is treated as membership, so
 * "分類 是 貼紙" reads the way it looks.
 */
export function matches(value: unknown, rule: FilterRule, type: FilterFieldType = 'text'): boolean {
  if (rule.value.trim() === '') return true

  if (Array.isArray(value)) {
    const has = value.map(String).includes(rule.value)
    return rule.operator === 'ne' ? !has : has
  }

  if (type === 'date') {
    const seconds = Number(value)
    if (!Number.isFinite(seconds)) return false
    const bound = rule.operator === 'lte' ? dayEnd(rule.value) : dayStart(rule.value)
    if (bound === null) return true
    return rule.operator === 'lte' ? seconds <= bound : seconds >= bound
  }

  if (type === 'number') {
    const left = Number(value)
    const right = Number(rule.value)
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false
    if (rule.operator === 'gte') return left >= right
    if (rule.operator === 'lte') return left <= right
    return left === right
  }

  const text = value === null || value === undefined ? '' : String(value)
  switch (rule.operator) {
    case 'contains':
      return text.toLowerCase().includes(rule.value.toLowerCase())
    case 'ne':
      return text !== rule.value
    default:
      return text === rule.value
  }
}

/**
 * Every rule has to hold. `read` is how a row answers for one field, which
 * keeps this function ignorant of what is being listed.
 */
export function applyFilters<T>(
  rows: T[],
  rules: FilterRule[],
  fields: FilterField[],
  read: (row: T, field: string) => unknown,
): T[] {
  const byName = new Map(fields.map((field) => [field.name, field]))
  const usable = rules.filter((rule) => byName.has(rule.field))
  if (usable.length === 0) return rows
  return rows.filter((row) =>
    usable.every((rule) => matches(read(row, rule.field), rule, byName.get(rule.field)?.type ?? 'text')),
  )
}

/** How many rules are actually doing something, for the "篩選 (2)" label. */
export function activeCount(rules: FilterRule[]): number {
  return rules.filter((rule) => rule.value.trim() !== '').length
}
