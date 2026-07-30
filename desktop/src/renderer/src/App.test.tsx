// @vitest-environment happy-dom

/**
 * The skeleton's one behaviour: it says what this tool is and what it holds.
 *
 * Worth a test rather than a glance, because the sentence about not holding an
 * R2 key is the thing somebody needs to read before installing this on a
 * laptop, and a refactor that drops a paragraph does not look like a bug.
 */

import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { App } from './App'

let container: HTMLDivElement

beforeEach(() => {
  // The bridge is provided by the preload script, which does not exist here.
  // Stubbed rather than mocked away, so the component still goes through the
  // same call it will make in the app.
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
  throw new Error('the version never arrived')
}

test('it says the tool holds no R2 key', async () => {
  render(<App />, container)
  await settle()

  expect(container.textContent).toContain('沒有 R2 金鑰')
})

test('it reports its version across the bridge', async () => {
  render(<App />, container)
  await settle()

  expect(container.textContent).toContain('1.2.3')
})

test('a bridge that answers slowly shows something rather than an empty line', async () => {
  render(<App />, container)

  expect(container.textContent).toContain('讀取中')
})
