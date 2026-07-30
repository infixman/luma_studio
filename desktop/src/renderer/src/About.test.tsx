// @vitest-environment happy-dom

/**
 * The About footer, and the licence window behind it.
 *
 * Tested because it is an obligation rather than a credit: this tool installs a
 * GPL binary, so the terms have to be readable — and a refactor that drops the
 * window does not look like a bug.
 *
 * The terms are bundled into the build rather than read from the FFmpeg install,
 * so there is no loading state to test and no missing-file state either. What is
 * worth pinning is that the bundled text is the real thing: a stub that says
 * "GPL" would pass a naive assertion and satisfy nothing.
 *
 * There is no source-archive control any more, and one test says so. The
 * corresponding-source obligation begins on conveying the binary to somebody
 * else, and this tool is installed by the two admins who own it — so the honest
 * thing to show is which build it is and where it came from. A button that
 * implies the obligation has been met, while pointing at a file nothing ever
 * downloads, is worse than no button.
 */

import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { About } from './About'

let container: HTMLDivElement

beforeEach(() => {
  Object.defineProperty(window, 'desktop', {
    configurable: true,
    value: { version: vi.fn(async () => '1.2.3') },
  })
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

function opener(): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((element) =>
    element.textContent?.includes('授權條款'),
  )
}

function box(): HTMLTextAreaElement | null {
  return container.querySelector('textarea.licence')
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
  expect(opener()).toBeDefined()
})

test('nothing is open until somebody asks', async () => {
  render(<About />, container)
  await settle()

  expect(box()).toBeNull()
})

test('the terms are the whole licence, not a mention of one', async () => {
  /** The obligation is the text. A stub with the word GPL in it would pass a
   *  looser assertion and satisfy nothing, so this checks the opening line and
   *  the length. */
  render(<About />, container)
  await settle()

  opener()?.click()
  await flush()

  expect(box()?.value).toContain('GNU GENERAL PUBLIC LICENSE')
  expect(box()?.value).toContain('Version 3, 29 June 2007')
  expect((box()?.value ?? '').length).toBeGreaterThan(30_000)
})

test('the terms cannot be edited', async () => {
  /** A text box somebody can type into invites the thought that the licence is
   *  a setting. */
  render(<About />, container)
  await settle()

  opener()?.click()
  await flush()

  expect(box()?.readOnly).toBe(true)
})

test('its height is stated in lines so it cannot outgrow the window', async () => {
  render(<About />, container)
  await settle()

  opener()?.click()
  await flush()

  // `Number(...)`: happy-dom hands `rows` back as the attribute string.
  expect(Number(box()?.rows)).toBeLessThanOrEqual(30)
  expect(Number(box()?.rows)).toBeGreaterThanOrEqual(20)
})

test('the window can be closed again', async () => {
  render(<About />, container)
  await settle()
  opener()?.click()
  await flush()

  const close = [...container.querySelectorAll('button')].find(
    (element) => element.getAttribute('aria-label') === '關閉',
  )
  close?.click()
  await flush()

  expect(box()).toBeNull()
})

test('escape closes it too', async () => {
  render(<About />, container)
  await settle()
  opener()?.click()
  await flush()

  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await flush()

  expect(box()).toBeNull()
})

test('it says which build this is and where it came from', async () => {
  /** What replaced the "open the corresponding source" button. That button
   *  pointed at an archive this tool never downloads, so it did nothing — and a
   *  control that implies an obligation has been met is worse than none. The
   *  source obligation begins on conveying the binary to somebody else; this is
   *  installed by the admins who own it. */
  render(<About />, container)
  await settle()

  opener()?.click()
  await flush()

  const sheet = container.querySelector('.sheet')?.textContent ?? ''

  expect(sheet).toContain('gyan.dev')
  expect(sheet).toContain('38b88335f9')
  expect(sheet).toContain('GPL')
})

test('and offers nothing that claims to open a source archive', async () => {
  render(<About />, container)
  await settle()
  opener()?.click()
  await flush()

  const buttons = [...container.querySelectorAll('button')].map((b) => b.textContent ?? '')

  expect(buttons.some((label) => label.includes('原始碼'))).toBe(false)
})
