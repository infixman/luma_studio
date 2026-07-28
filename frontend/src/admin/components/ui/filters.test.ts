import { describe, expect, it } from 'vitest'

import { applyFilters, activeCount, dayEnd, dayStart, matches } from './filters'
import type { FilterField, FilterRule } from './filters'

/** A rule without the ceremony of an id nobody in these tests looks at. */
function rule(field: string, operator: FilterRule['operator'], value: string): FilterRule {
  return { id: `${field}-${operator}-${value}`, field, operator, value }
}

const FIELDS: FilterField[] = [
  { name: 'status', label: '狀態', type: 'enum' },
  { name: 'title', label: '名稱', type: 'text' },
  { name: 'stock', label: '庫存', type: 'number' },
  { name: 'createdAt', label: '建立時間', type: 'date' },
  { name: 'categories', label: '分類', type: 'enum' },
]

interface Row {
  status: string
  title: string
  stock: number
  createdAt: number
  categories: string[]
}

const ROWS: Row[] = [
  { status: 'active', title: '貼紙組', stock: 12, createdAt: dayStart('2026-07-01')!, categories: ['paper'] },
  { status: 'draft', title: '明信片', stock: 0, createdAt: dayStart('2026-07-15')!, categories: ['paper', 'gift'] },
  { status: 'active', title: '木框', stock: 3, createdAt: dayStart('2026-08-02')!, categories: [] },
]

const read = (row: Row, field: string) => row[field as keyof Row]
const titles = (rows: Row[]) => rows.map((row) => row.title)

describe('a rule on its own', () => {
  it('lets everything through until it has a value', () => {
    // Otherwise clicking "新增篩選" empties the list before anybody has said
    // what to filter by, which reads as the button having broken something.
    expect(matches('active', rule('status', 'eq', ''), 'enum')).toBe(true)
    expect(matches('active', rule('status', 'eq', '   '), 'enum')).toBe(true)
  })

  it('compares text without caring about case', () => {
    expect(matches('Sticker Pack', rule('title', 'contains', 'sticker'), 'text')).toBe(true)
    expect(matches('Sticker Pack', rule('title', 'contains', 'poster'), 'text')).toBe(false)
  })

  it('reads a list as membership, so 「分類 是 貼紙」 means what it looks like', () => {
    expect(matches(['paper', 'gift'], rule('categories', 'eq', 'gift'), 'enum')).toBe(true)
    expect(matches(['paper'], rule('categories', 'eq', 'gift'), 'enum')).toBe(false)
    expect(matches(['paper'], rule('categories', 'ne', 'gift'), 'enum')).toBe(true)
  })

  it('compares numbers as numbers rather than as the strings they arrive as', () => {
    expect(matches(9, rule('stock', 'gte', '10'), 'number')).toBe(false)
    expect(matches(90, rule('stock', 'gte', '10'), 'number')).toBe(true)
  })
})

describe('dates', () => {
  it('turns a date into the whole day, in the reader’s own timezone', () => {
    const start = dayStart('2026-07-15')
    const end = dayEnd('2026-07-15')
    expect(start).not.toBeNull()
    expect(new Date(start! * 1000).getHours()).toBe(0)
    expect(end! - start!).toBe(24 * 60 * 60 - 1)
  })

  it('includes the day named on both sides of the range', () => {
    // "在這天之前（含當天）" has to include an order placed at eleven at night,
    // or a range that visibly names its date silently excludes it.
    const evening = dayStart('2026-07-15')! + 23 * 60 * 60
    expect(matches(evening, rule('createdAt', 'lte', '2026-07-15'), 'date')).toBe(true)
    expect(matches(evening, rule('createdAt', 'gte', '2026-07-15'), 'date')).toBe(true)
    expect(matches(evening, rule('createdAt', 'gte', '2026-07-16'), 'date')).toBe(false)
  })

  it('ignores a bound it cannot read rather than treating it as the epoch', () => {
    expect(matches(0, rule('createdAt', 'gte', '上禮拜二'), 'date')).toBe(true)
  })
})

describe('stacking', () => {
  it('applies every rule, not the last one', () => {
    const rules = [rule('status', 'eq', 'active'), rule('stock', 'gte', '5')]
    expect(titles(applyFilters(ROWS, rules, FIELDS, read))).toEqual(['貼紙組'])
  })

  it('narrows a date range from both ends', () => {
    const rules = [rule('createdAt', 'gte', '2026-07-10'), rule('createdAt', 'lte', '2026-07-31')]
    expect(titles(applyFilters(ROWS, rules, FIELDS, read))).toEqual(['明信片'])
  })

  it('returns nothing for two rules that cannot both hold, rather than picking one', () => {
    // AND is what the rows say on screen. Quietly dropping one would be a
    // filter that lies about what it did.
    const rules = [rule('status', 'eq', 'active'), rule('status', 'eq', 'draft')]
    expect(applyFilters(ROWS, rules, FIELDS, read)).toEqual([])
  })

  it('ignores a rule naming a field this list does not have', () => {
    const rules = [rule('colour', 'eq', 'blue')]
    expect(applyFilters(ROWS, rules, FIELDS, read)).toHaveLength(ROWS.length)
  })

  it('counts only the rules that are doing something', () => {
    expect(activeCount([rule('status', 'eq', 'active'), rule('stock', 'gte', '')])).toBe(1)
  })
})
