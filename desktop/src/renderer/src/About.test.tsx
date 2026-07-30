// @vitest-environment happy-dom

/**
 * The About footer.
 *
 * The FFmpeg paths are tested because they are an obligation rather than a
 * credit: this tool distributes a GPL binary, so the licence and the
 * corresponding source ship with it — and shipping them is only half of it.
 * Somebody has to be able to find them without reading the repository, and a
 * refactor that drops a `<details>` block does not look like a bug.
 */

import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { About } from './About'

let container: HTMLDivElement

beforeEach(() => {
  Object.defineProperty(window, 'desktop', {
    configurable: true,
    value: {
      version: vi.fn(async () => '1.2.3'),
      licences: vi.fn(async () => ({
        licence: '/tools/ffmpeg/LICENSE',
        source: '/tools/ffmpeg-source.tar.xz',
      })),
    },
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

test('it reports the version', async () => {
  render(<About />, container)
  await settle()

  expect(container.textContent).toContain('1.2.3')
})

test('it names FFmpeg and its licence', async () => {
  render(<About />, container)
  await settle()

  expect(container.textContent).toContain('FFmpeg')
  expect(container.textContent).toContain('GPL')
})

test('it gives the path to the licence text', async () => {
  render(<About />, container)
  await settle()

  expect(container.textContent).toContain('/tools/ffmpeg/LICENSE')
})

test('and to the corresponding source', async () => {
  /** The half people forget. A licence without the source it applies to does
   *  not satisfy the GPL. */
  render(<About />, container)
  await settle()

  expect(container.textContent).toContain('/tools/ffmpeg-source.tar.xz')
})

test('it says the tool holds no R2 key', async () => {
  render(<About />, container)
  await settle()

  expect(container.textContent).toContain('沒有 R2 金鑰')
})
