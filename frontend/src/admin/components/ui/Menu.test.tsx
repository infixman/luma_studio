// @vitest-environment happy-dom

/**
 * The `⋯` menu, and where its popup lands.
 *
 * It used to be an absolutely-positioned child of the trigger, which meant the
 * first scrolling ancestor clipped it — and on every list page that ancestor is
 * the table's own `overflow-x`. The menu on the right-hand column came out with
 * its right half cut off, so the items were unreadable exactly where the row
 * actions live.
 */

import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { Menu, MenuItem } from './Menu'

let container: HTMLDivElement

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  // happy-dom has no layout, so the trigger has to say where it is.
  Element.prototype.getBoundingClientRect = function () {
    return { top: 100, bottom: 130, left: 900, right: 940, width: 40, height: 30, x: 900, y: 100, toJSON() {} }
  }
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 })
})

afterEach(() => {
  render(null, container)
  container.remove()
})

/** Preact renders on a microtask, so a click is not visible until it runs. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 10; tick++) await new Promise((resolve) => setTimeout(resolve, 0))
}

async function openMenu(onChoose: () => void = () => {}): Promise<void> {
  render(
    <Menu label="這一列的動作">
      <MenuItem onClick={onChoose}>預覽</MenuItem>
    </Menu>,
    container,
  )
  container.querySelector('button')!.click()
  await settle()
}

test('the popup is placed against the viewport, so nothing can clip it', async () => {
  await openMenu()

  const popup = container.querySelector<HTMLElement>('[role="menu"]')!
  // Under the trigger and aligned to its right edge: 1000 - 940.
  expect(popup.style.top).toBe('134px')
  expect(popup.style.right).toBe('60px')
})

test('scrolling closes it rather than leaving it beside the wrong row', async () => {
  /** The other half of pinning it to the viewport: it no longer travels with
   *  the thing it belongs to. */
  await openMenu()
  expect(container.querySelector('[role="menu"]')).not.toBeNull()

  window.dispatchEvent(new Event('scroll'))
  await settle()

  expect(container.querySelector('[role="menu"]')).toBeNull()
})

test('choosing an item still runs it and closes the menu', async () => {
  const chosen = vi.fn()
  await openMenu(chosen)

  container.querySelector<HTMLElement>('.ui-menu-item')!.click()
  await settle()

  expect(chosen).toHaveBeenCalledOnce()
  expect(container.querySelector('[role="menu"]')).toBeNull()
})
