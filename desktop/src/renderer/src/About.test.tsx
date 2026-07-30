// @vitest-environment happy-dom

/**
 * The About footer, and the licence window behind it.
 *
 * Tested because it is an obligation rather than a credit: this tool
 * distributes a GPL binary, so the licence text has to be readable and the
 * corresponding source has to be reachable — and a refactor that drops either
 * does not look like a bug.
 *
 * The paths used to be printed in the footer. They are not any more, which
 * moves the source from "written on the screen" to "one button away", so the
 * button is what these tests pin.
 */

import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { About } from './About'

let container: HTMLDivElement
let licenceText: ReturnType<typeof vi.fn>
let revealSource: ReturnType<typeof vi.fn>

const LICENCE = 'GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n...'

function bridge(text: string | null): void {
  licenceText = vi.fn(async () => text)
  revealSource = vi.fn(async () => true)
  Object.defineProperty(window, 'desktop', {
    configurable: true,
    value: {
      version: vi.fn(async () => '1.2.3'),
      licenceText,
      revealSource,
    },
  })
}

beforeEach(() => {
  bridge(LICENCE)
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => {
  render(null, container)
  container.remove()
})

async function settle(): Promise<void> {
  for (let tick = 0; tick < 30; tick++) {
    if (!(container.textContent ?? '').includes('讀取中')) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('the About footer never finished loading')
}

async function flush(): Promise<void> {
  for (let tick = 0; tick < 30; tick++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function open(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((element) =>
    element.textContent?.includes('授權'),
  )
}

test('it reports the version', async () => {
  render(<About />, container)
  await settle()

  expect(container.textContent).toContain('1.2.3')
})

test('the footer is the version and a way in, not a wall of paths', async () => {
  render(<About />, container)
  await settle()

  expect(container.textContent).not.toContain('LICENSE')
  expect(container.textContent).not.toContain('.tar.xz')
  expect(open()).toBeDefined()
})

test('nothing is read until somebody asks', async () => {
  /** The licence is a hundred kilobytes of text that almost nobody opens. */
  render(<About />, container)
  await settle()

  expect(licenceText).not.toHaveBeenCalled()
})

test('the licence text itself is what the window shows', async () => {
  render(<About />, container)
  await settle()

  open()?.click()
  await flush()

  expect(container.textContent).toContain('GNU GENERAL PUBLIC LICENSE')
})

test('the window can be closed again', async () => {
  render(<About />, container)
  await settle()
  open()?.click()
  await flush()

  const close = [...container.querySelectorAll('button')].find(
    (element) => element.getAttribute('aria-label') === '關閉',
  )
  close?.click()
  await flush()

  expect(container.textContent).not.toContain('GNU GENERAL PUBLIC LICENSE')
})

test('escape closes it too', async () => {
  render(<About />, container)
  await settle()
  open()?.click()
  await flush()

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await flush()

  expect(container.textContent).not.toContain('GNU GENERAL PUBLIC LICENSE')
})

test('the corresponding source is reachable from the window', async () => {
  /** The half people forget. A licence without the source it applies to does
   *  not satisfy the GPL, and hiding the path only shifts the obligation from
   *  printing it to opening it. */
  render(<About />, container)
  await settle()
  open()?.click()
  await flush()

  const reveal = [...container.querySelectorAll('button')].find((element) =>
    element.textContent?.includes('原始碼'),
  )
  reveal?.click()
  await flush()

  expect(revealSource).toHaveBeenCalled()
})

test('a missing licence file says so rather than showing an empty window', async () => {
  /** True on any machine where FFmpeg has not been fetched yet, which is every
   *  machine before the first transcode. An empty panel reads as broken. */
  bridge(null)
  render(<About />, container)
  await settle()

  open()?.click()
  await flush()

  expect(container.textContent).toContain('還沒下載')
})
