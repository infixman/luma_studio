// @vitest-environment happy-dom

/**
 * The storage page.
 *
 * It exists to make somebody look at the bill, so the parts worth pinning are
 * the ones that would let it lie: an estimate invented when nobody configured a
 * price, a zero where nothing has been swept, and a delete button that does not
 * say what is lost.
 */

import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { CleanupCandidates, StorageSource, StorageSummary } from '../../shared/types'

const GIGABYTE = 1024 * 1024 * 1024

let summary: StorageSummary
let candidates: CleanupCandidates
let sources: StorageSource[]
const posted: { path: string; body: unknown }[] = []

vi.mock('../../shared/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../shared/api')>()
  return {
    ...actual,
    api: vi.fn(async (path: string) => {
      if (path.startsWith('/api/video-storage/summary')) return summary
      if (path.startsWith('/api/video-storage/cleanup-candidates')) return candidates
      if (path.startsWith('/api/video-storage/sources')) return { sources }
      if (path.startsWith('/api/video-storage/orphans')) return { objects: [] }
      return {}
    }),
    apiJson: vi.fn(async (path: string, _method: string, body: unknown) => {
      posted.push({ path, body })
      return {}
    }),
  }
})

vi.mock('../lib/session', () => ({ signedInEmail: () => 'owner@example.com' }))

import { StoragePage } from './StoragePage'

let container: HTMLDivElement

beforeEach(() => {
  posted.length = 0
  summary = {
    source: { bytes: 200 * GIGABYTE, objects: 42 },
    output: { bytes: 90 * GIGABYTE, objects: 8734 },
    orphans: null,
    estimate: {
      monthlyUsd: 4.2,
      pricePerGbMonthUsd: 0.015,
      freeGb: 10,
      excludesOperations: true,
    },
    growth: { bytesThisMonth: 20 * GIGABYTE },
  }
  candidates = { safe: [], needsJudgement: [], scannedAt: null }
  sources = []
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => {
  render(null, container)
  container.remove()
})

async function settle(): Promise<void> {
  for (let tick = 0; tick < 40; tick++) {
    if (!(container.textContent ?? '').includes('載入中')) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('the page never finished loading')
}

async function flush(): Promise<void> {
  for (let tick = 0; tick < 20; tick++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function buttonFor(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((element) =>
    (element.textContent ?? '').includes(label),
  )
}

test('the capacity and the money are the first thing on the page', async () => {
  /** Nothing else about a course library reminds anybody that last year's
   *  re-encodes are still there. */
  render(<StoragePage />, container)
  await settle()

  expect(container.textContent).toContain('200.0 GB')
  expect(container.textContent).toContain('US$4.20')
})

test('the estimate says it is one', async () => {
  render(<StoragePage />, container)
  await settle()

  expect(container.textContent).toContain('估算')
  expect(container.textContent).toContain('不含操作費用')
})

test('a deployment with no configured price shows no number at all', async () => {
  /** R2's prices change, and a stale one reads exactly like an accurate one. */
  summary = { ...summary, estimate: null }
  render(<StoragePage />, container)
  await settle()

  expect(container.textContent).toContain('尚未設定單價')
  expect(container.textContent).not.toContain('US$')
})

test('never having swept says so rather than showing zero', async () => {
  /** "None found" and "never looked" are different facts, and only one of them
   *  is a reason to stop looking. */
  render(<StoragePage />, container)
  await settle()

  expect(container.textContent).toContain('尚未盤點')
})

test('a sweep that has run reports what it found and when', async () => {
  summary = {
    ...summary,
    orphans: { sourceBytes: 5 * GIGABYTE, outputBytes: 12 * GIGABYTE, scannedAt: 1785292800, truncated: false },
  }
  render(<StoragePage />, container)
  await settle()

  expect(container.textContent).toContain('12.0 GB')
  expect(container.textContent).not.toContain('尚未盤點')
})

test('clearing the safe list asks once and sends one request per entry', async () => {
  candidates = {
    safe: [
      { kind: 'orphan', bucket: 'output', keys: 312, bytes: 12 * GIGABYTE },
      { kind: 'supersededVersion', assetId: 'asset-1', title: '第一課', encodeVersion: 1, bytes: GIGABYTE },
    ],
    needsJudgement: [],
    scannedAt: 1785292800,
  }
  render(<StoragePage />, container)
  await settle()

  buttonFor('全部清除')?.click()
  await flush()
  buttonFor('確定清除')?.click()
  await flush()

  expect(posted.map((entry) => entry.path)).toEqual([
    '/api/video-storage/cleanup',
    '/api/video-storage/cleanup',
  ])
})

test('deleting an original names it and says what is lost', async () => {
  /** The one irreversible action on this page. A confirmation that does not say
   *  what it costs is a confirmation nobody read. */
  candidates = {
    safe: [],
    needsJudgement: [
      {
        kind: 'unusedSource',
        assetId: 'asset-1',
        title: '第一課',
        bytes: 4 * GIGABYTE,
        consequence: '刪除後這支影片無法再重新轉檔',
      },
    ],
    scannedAt: 1785292800,
  }
  render(<StoragePage />, container)
  await settle()

  buttonFor('刪除這一支')?.click()
  await flush()

  // Asserted inside the dialog. The same sentence is in the list behind it, so
  // a check on the whole page would pass with an empty confirmation.
  const dialog = container.querySelector('[role="dialog"]')
  expect(dialog?.textContent).toContain('第一課')
  expect(dialog?.textContent).toContain('無法再重新轉檔')
  expect(posted).toEqual([])
})

test('backing out of that dialog deletes nothing', async () => {
  candidates = {
    safe: [],
    needsJudgement: [
      {
        kind: 'unusedSource',
        assetId: 'asset-1',
        title: '第一課',
        bytes: 4 * GIGABYTE,
        consequence: '刪除後這支影片無法再重新轉檔',
      },
    ],
    scannedAt: 1785292800,
  }
  render(<StoragePage />, container)
  await settle()

  buttonFor('刪除這一支')?.click()
  await flush()
  buttonFor('取消')?.click()
  await flush()

  expect(posted).toEqual([])
})

test('there is no way to select every original at once', async () => {
  /** Each of these is a different video and a different loss. A list with a
   *  select-all is a list somebody clears in one afternoon. */
  candidates = {
    safe: [],
    needsJudgement: [
      { kind: 'unusedSource', assetId: 'a', title: '一', bytes: 1, consequence: '無法再重新轉檔' },
      { kind: 'unusedSource', assetId: 'b', title: '二', bytes: 1, consequence: '無法再重新轉檔' },
    ],
    scannedAt: 1,
  }
  render(<StoragePage />, container)
  await settle()

  expect(container.querySelector('input[type="checkbox"]')).toBeNull()
  expect(buttonFor('全部刪除')).toBeUndefined()
})

test('a source in use lists the lessons rather than a count', async () => {
  /** The decision is not "3 lessons", it is "that course closed last year". */
  sources = [
    {
      assetId: 'asset-1',
      title: '第一課',
      status: 'ready',
      bytes: 4 * GIGABYTE,
      hasPlayableVersion: true,
      activeEncodeVersion: 1,
      versionCount: 1,
      versionBytes: GIGABYTE,
      lessons: [
        { lessonId: 'l1', lessonTitle: '工具介紹', courseId: 'c1', courseTitle: '水彩入門' },
      ],
      createdAt: 1785292800,
    },
  ]
  render(<StoragePage />, container)
  await settle()

  buttonFor('原始檔')?.click()
  await flush()

  expect(container.textContent).toContain('水彩入門')
  const link = [...container.querySelectorAll('a')].find((element) =>
    (element.textContent ?? '').includes('水彩入門'),
  )
  expect(link?.getAttribute('href')).toBe('/courses/c1')
})
