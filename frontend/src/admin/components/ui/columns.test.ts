import { beforeEach, describe, expect, it, vi } from 'vitest'

import { choosableColumns, columnsName, readHidden, toggleHidden, visibleColumns, writeHidden } from './columns'
import type { ColumnSpec } from './columns'
import { key } from '../../lib/storage'

const COLUMNS: ColumnSpec[] = [
  { key: 'id', label: '訂單', fixed: true },
  { key: 'recipient', label: '收件人' },
  { key: 'total', label: '金額', numeric: true },
  { key: 'note', label: '備註' },
]

const keys = (columns: ColumnSpec[]) => columns.map((column) => column.key)

/** The tests run in node, where there is no window to borrow one from. */
function fakeStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => void values.delete(key),
    setItem: (key: string, value: string) => void values.set(key, value),
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeStorage())
})

describe('what gets drawn', () => {
  it('keeps a fixed column even when storage names it', () => {
    // A row with no id is a row nobody can act on, and a stale storage entry
    // from an older version of this table must not be able to produce one.
    expect(keys(visibleColumns(COLUMNS, ['id', 'note']))).toEqual(['id', 'recipient', 'total'])
  })

  it('never offers a fixed column in the chooser', () => {
    expect(keys(choosableColumns(COLUMNS))).toEqual(['recipient', 'total', 'note'])
  })

  it('shows a column added since the choice was made', () => {
    // The stored set is what is *hidden*, which is the whole reason this
    // works: a new column is not in it, so it appears rather than being
    // invisible forever with nothing on screen to explain why.
    const hidden = ['note']
    const withNewColumn: ColumnSpec[] = [...COLUMNS, { key: 'email', label: 'Email' }]
    expect(keys(visibleColumns(withNewColumn, hidden))).toEqual(['id', 'recipient', 'total', 'email'])
  })
})

describe('remembering', () => {
  it('tells "never chosen" apart from "chosen, and it was everything"', () => {
    // The difference is real: a page whose default hides four columns has to
    // hand those defaults to a newcomer and not to somebody who has just
    // deliberately switched every column back on.
    expect(readHidden('orders')).toBeNull()
    writeHidden('orders', [])
    expect(readHidden('orders')).toEqual([])
  })

  it('survives a round trip', () => {
    writeHidden('orders', ['note', 'total'])
    expect(readHidden('orders')).toEqual(['note', 'total'])
  })

  it('keeps each page apart', () => {
    writeHidden('orders', ['note'])
    writeHidden('products', ['slug'])
    expect(readHidden('orders')).toEqual(['note'])
    expect(readHidden('products')).toEqual(['slug'])
  })

  it('falls back to the defaults when what was stored is not a list of keys', () => {
    localStorage.setItem(key(columnsName('orders')), '{ this is not json')
    expect(readHidden('orders')).toBeNull()
    localStorage.setItem(key(columnsName('orders')), '{"note":true}')
    expect(readHidden('orders')).toBeNull()
  })

  it('drops anything in storage that is not a string', () => {
    localStorage.setItem(key(columnsName('orders')), '["note", 7, null]')
    expect(readHidden('orders')).toEqual(['note'])
  })

  it('does not take the page down when storage refuses to answer', () => {
    vi.stubGlobal('localStorage', {
      getItem() {
        throw new Error('storage is off')
      },
      setItem() {
        throw new Error('storage is off')
      },
    })
    expect(readHidden('orders')).toBeNull()
    expect(() => writeHidden('orders', ['note'])).not.toThrow()
  })
})

describe('toggling', () => {
  it('switches a column off and back on', () => {
    expect(toggleHidden(COLUMNS, [], 'note')).toEqual(['note'])
    expect(toggleHidden(COLUMNS, ['note'], 'note')).toEqual([])
  })

  it('refuses to hide a fixed column even when asked directly', () => {
    expect(toggleHidden(COLUMNS, [], 'id')).toEqual([])
  })

  it('sweeps out keys this table no longer has', () => {
    // Otherwise a browser accumulates the name of every column this back
    // office has ever had, forever.
    expect(toggleHidden(COLUMNS, ['gone', 'note'], 'total').sort()).toEqual(['note', 'total'])
  })
})
