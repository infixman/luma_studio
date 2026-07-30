// @vitest-environment happy-dom

/**
 * Six digit slots.
 *
 * Segmented inputs are pleasant when they behave and infuriating when they do
 * not, and the two things that decide which are pasting and backspace. Both are
 * tested here rather than through the pairing form, because the form's job is
 * what it does with a finished code.
 */

import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { CodeInput } from './CodeInput'

let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => {
  render(null, container)
  container.remove()
})

function slots(): HTMLInputElement[] {
  return [...container.querySelectorAll<HTMLInputElement>('.code-slot')]
}

function typeInto(index: number, text: string): void {
  const field = slots()[index]!
  field.value = text
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

function pressKey(index: number, key: string): void {
  slots()[index]!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

test('there are six of them', async () => {
  render(<CodeInput value="" onChange={vi.fn()} />, container)

  expect(slots()).toHaveLength(6)
})

test('a digit typed into a slot is reported', async () => {
  const onChange = vi.fn()
  render(<CodeInput value="" onChange={onChange} />, container)

  typeInto(0, '4')

  expect(onChange).toHaveBeenCalledWith('4')
})

test('a digit typed into a later slot lands there', async () => {
  const onChange = vi.fn()
  render(<CodeInput value="41" onChange={onChange} />, container)

  typeInto(2, '8')

  expect(onChange).toHaveBeenCalledWith('418')
})

test('a pasted code fills every slot', async () => {
  /** The back office renders `418 302`, so that is what gets pasted. Per-slot
   *  `maxLength={1}` would keep the 4 and drop the rest. */
  const onChange = vi.fn()
  render(<CodeInput value="" onChange={onChange} />, container)

  typeInto(0, '418 302')

  expect(onChange).toHaveBeenCalledWith('418302')
})

test('a pasted code with other separators fills every slot too', async () => {
  const onChange = vi.fn()
  render(<CodeInput value="" onChange={onChange} />, container)

  typeInto(0, '418-302')

  expect(onChange).toHaveBeenCalledWith('418302')
})

test('a paste longer than six digits does not overflow', async () => {
  const onChange = vi.fn()
  render(<CodeInput value="" onChange={onChange} />, container)

  typeInto(0, '4183021234')

  expect(onChange).toHaveBeenCalledWith('418302')
})

test('letters are ignored rather than shown', async () => {
  const onChange = vi.fn()
  render(<CodeInput value="" onChange={onChange} />, container)

  typeInto(0, 'a')

  expect(onChange).not.toHaveBeenCalled()
})

test('the value passed in is what the slots show', async () => {
  render(<CodeInput value="418302" onChange={vi.fn()} />, container)

  expect(slots().map((field) => field.value)).toEqual(['4', '1', '8', '3', '0', '2'])
})

test('a value with a space in it still lines up one digit per slot', async () => {
  render(<CodeInput value="418 302" onChange={vi.fn()} />, container)

  expect(slots().map((field) => field.value)).toEqual(['4', '1', '8', '3', '0', '2'])
})

test('backspace clears the slot it is in', async () => {
  const onChange = vi.fn()
  render(<CodeInput value="418302" onChange={onChange} />, container)

  pressKey(5, 'Backspace')

  expect(onChange).toHaveBeenCalledWith('41830')
})

test('backspace in an empty slot clears the one before it', async () => {
  /** Two presses to delete one character is the thing that makes segmented
   *  inputs unpleasant. */
  const onChange = vi.fn()
  render(<CodeInput value="418" onChange={onChange} />, container)

  pressKey(3, 'Backspace')

  expect(onChange).toHaveBeenCalledWith('41')
})

test('backspace in the first slot does not throw', async () => {
  const onChange = vi.fn()
  render(<CodeInput value="" onChange={onChange} />, container)

  expect(() => pressKey(0, 'Backspace')).not.toThrow()
})

test('every slot is announced by position', async () => {
  /** They are six unlabelled boxes to a screen reader otherwise. */
  render(<CodeInput value="" onChange={vi.fn()} />, container)

  expect(slots().map((field) => field.getAttribute('aria-label'))).toEqual([
    '第 1 位',
    '第 2 位',
    '第 3 位',
    '第 4 位',
    '第 5 位',
    '第 6 位',
  ])
})

test('the group says what it is', async () => {
  render(<CodeInput value="" onChange={vi.fn()} />, container)

  expect(container.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('驗證碼')
})

test('disabled disables all of them', async () => {
  render(<CodeInput value="" disabled onChange={vi.fn()} />, container)

  expect(slots().every((field) => field.disabled)).toBe(true)
})
