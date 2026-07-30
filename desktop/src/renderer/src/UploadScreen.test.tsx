// @vitest-environment happy-dom

/**
 * The upload screen.
 *
 * What is worth pinning is what it tells somebody when things are not fine: a
 * folder with no encode in it, files it is going to ignore, and a registration
 * that came back short. The happy path is one button.
 */

import { render } from 'preact'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { UploadScreen } from './UploadScreen'
import type { Progress, ScannedFolder, UploadResult } from '../../shared/upload'

const SCANNED: ScannedFolder = {
  folder: 'C:\\encodes\\asset-1\\1',
  objects: ['720p/init.mp4', '720p/segment-000001.m4s', 'master.m3u8'],
  unexpected: [],
  totalBytes: 5_242_880,
}

let container: HTMLDivElement
let scan: ReturnType<typeof vi.fn>
let start: ReturnType<typeof vi.fn>
let cancelUpload: ReturnType<typeof vi.fn>
let emit: ((progress: Progress) => void) | null = null

function bridge(): void {
  cancelUpload = vi.fn(async () => undefined)
  scan = vi.fn(async () => ({ ok: true, scanned: SCANNED }))
  start = vi.fn(
    async (): Promise<UploadResult> => ({
      ok: true,
      result: { phase: 'done', uploaded: 3, total: 3, message: '已驗證 3 個檔案' },
    }),
  )
  Object.defineProperty(window, 'desktop', {
    configurable: true,
    value: {
      version: vi.fn(async () => '1.2.3'),
      pathFor: vi.fn(() => SCANNED.folder),
      auth: { status: vi.fn(), pair: vi.fn(), signOut: vi.fn() },
      upload: {
        scan,
        start,
        cancel: cancelUpload,
        onProgress: (listener: (progress: Progress) => void) => {
          emit = listener
          return () => {
            emit = null
          }
        },
      },
    },
  })
}

beforeEach(() => {
  emit = null
  bridge()
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(() => {
  render(null, container)
  container.remove()
})

async function tick(): Promise<void> {
  for (let count = 0; count < 20; count++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function drop(path: string = SCANNED.folder, count = 1): void {
  ;(window.desktop.pathFor as ReturnType<typeof vi.fn>).mockReturnValue(path)
  const zone = container.querySelector('.drop')!
  const event = new Event('drop', { bubbles: true, cancelable: true }) as DragEvent
  const files = Array.from({ length: count }, (_unused, index) => new File([], `x${index}`))
  Object.defineProperty(event, 'dataTransfer', { value: { files } })
  zone.dispatchEvent(event)
}

/**
 * Awaited, because the drop listeners are attached in an effect and Preact runs
 * effects asynchronously. Mounting and dropping in one tick drops onto an
 * element with no listener yet, which looks exactly like a broken handler.
 */
async function mount(): Promise<void> {
  render(<UploadScreen adminEmail="owner@example.com" onSignOut={vi.fn()} />, container)
  await tick()
}

test('it says who it is connected as', async () => {
  await mount()

  expect(container.textContent).toContain('owner@example.com')
})

test('dropping a folder scans it and reports what is there', async () => {
  await mount()
  drop()
  await tick()

  expect(scan).toHaveBeenCalledWith(SCANNED.folder)
  expect(container.textContent).toContain('3')
  expect(container.textContent).toContain('5.0 MB')
})

test('a folder with no encode in it is explained', async () => {
  /** Rather than an upload button that does nothing. */
  scan.mockResolvedValue({ ok: true, scanned: { ...SCANNED, objects: [], totalBytes: 0 } })
  await mount()
  drop()
  await tick()

  expect(container.textContent).toContain('master.m3u8')
  expect(container.querySelector('.alert')).not.toBeNull()
})

test('files that will be ignored are named', async () => {
  /** Silence here reads as "it uploaded everything", and the one time that
   *  matters is when somebody dropped the wrong folder. */
  scan.mockResolvedValue({ ok: true, scanned: { ...SCANNED, unexpected: ['notes.txt', 'source.mp4'] } })
  await mount()
  drop()
  await tick()

  expect(container.textContent).toContain('notes.txt')
  expect(container.textContent).toContain('略過')
})

test('starting an upload sends the folder', async () => {
  await mount()
  drop()
  await tick()

  const button = [...container.querySelectorAll('button')].find((element) =>
    element.textContent?.includes('開始上傳'),
  )
  button?.click()
  await tick()

  expect(start).toHaveBeenCalledWith({ folder: SCANNED.folder, title: '' })
})

test('progress events move the bar', async () => {
  await mount()
  drop()
  await tick()

  emit?.({ phase: 'uploading', uploaded: 1, total: 4 })
  await tick()

  expect(container.querySelector<HTMLElement>('.bar div')?.style.width).toBe('25%')
  expect(container.textContent).toContain('1 / 4')
})

test('verification is its own phase, not folded into uploading', async () => {
  /** It is the step that decides whether the video plays. "The upload finished"
   *  and "the video works" are different claims. */
  await mount()
  drop()
  await tick()

  emit?.({ phase: 'registering', uploaded: 4, total: 4 })
  await tick()

  expect(container.textContent).toContain('驗證中')
})

test('a short registration lists what is missing', async () => {
  /** The most useful thing this screen can show: what to upload again. */
  await mount()
  drop()
  await tick()

  emit?.({
    phase: 'failed',
    uploaded: 4,
    total: 6,
    message: '還缺 2 個檔案，再按一次上傳只會補這些',
    missing: ['720p/segment-000004.m4s', 'poster.webp'],
  })
  await tick()

  expect(container.textContent).toContain('720p/segment-000004.m4s')
  expect(container.textContent).toContain('poster.webp')
})

test('a failure from the main process is shown rather than swallowed', async () => {
  start.mockResolvedValue({ ok: false, message: '配對已過期，請重新配對', httpStatus: 401 })
  await mount()
  drop()
  await tick()

  const button = [...container.querySelectorAll('button')].find((element) =>
    element.textContent?.includes('開始上傳'),
  )
  button?.click()
  await tick()

  expect(container.textContent).toContain('配對已過期')
})

test('the upload button is disabled while it runs', async () => {
  await mount()
  drop()
  await tick()

  emit?.({ phase: 'uploading', uploaded: 1, total: 4 })
  await tick()

  const button = [...container.querySelectorAll('button')].find((element) =>
    element.textContent?.includes('進行中'),
  )
  expect(button?.disabled).toBe(true)
})

test('dropping an MP4 shows the file and does not scan it as a folder', async () => {
  /** A source is transcoded here; scanning it as a folder would fail with the
   *  wrong sentence. */
  await mount()
  drop('C:\videos\lesson 01.mp4')
  await tick()

  expect(scan).not.toHaveBeenCalled()
  expect(container.textContent).toContain('lesson 01.mp4')
  expect(container.textContent).toContain('影片檔')
})

test('starting from an MP4 sends the source, not a folder', async () => {
  await mount()
  drop('C:\videos\lesson 01.mp4')
  await tick()

  // The button says what it will do, and for a source that includes transcoding.
  const button = [...container.querySelectorAll('button')].find((element) =>
    element.textContent?.includes('轉檔並上傳'),
  )
  button?.click()
  await tick()

  expect(start).toHaveBeenCalledWith({ source: 'C:\videos\lesson 01.mp4', title: '' })
})

test('the transcode phases have their own labels', async () => {
  /** "上傳中" during an hour of encoding would be a lie about what is happening. */
  await mount()
  drop('C:\videos\a.mp4')
  await tick()

  emit?.({ phase: 'encoding', uploaded: 0, total: 0, fraction: 0.4, rung: '720p' })
  await tick()

  expect(container.textContent).toContain('轉檔中')
  expect(container.textContent).toContain('720p')
})

test('the bar follows the transcode fraction, since there is nothing to count', async () => {
  await mount()
  drop('C:\videos\a.mp4')
  await tick()

  emit?.({ phase: 'encoding', uploaded: 0, total: 0, fraction: 0.25 })
  await tick()

  expect(container.querySelector<HTMLElement>('.bar div')?.style.width).toBe('25%')
})

test('dropping something that is neither says both options', async () => {
  scan.mockResolvedValue({
    ok: true,
    scanned: { folder: 'D:\\junk', objects: [], unexpected: [], totalBytes: 0 },
  })
  await mount()
  drop('D:\\junk')
  await tick()

  // The folder it is about, then both ways out of the situation.
  expect(container.textContent).toContain('junk')
  expect(container.textContent).toContain('.mp4')
  expect(container.textContent).toContain('master.m3u8')
})

test('a running job can be cancelled', async () => {
  /** An encode is tens of minutes. Without this, "cancel" could only mean
   *  "stop watching" while a core stays busy on output nobody will use. */
  await mount()
  drop('C:\videos\a.mp4')
  await tick()

  emit?.({ phase: 'encoding', uploaded: 0, total: 0, fraction: 0.3, rung: '1080p' })
  await tick()

  const button = [...container.querySelectorAll('button')].find(
    (element) => element.textContent?.trim() === '取消',
  )
  button?.click()
  await tick()

  expect(cancelUpload).toHaveBeenCalled()
})

test('there is nothing to cancel before a job starts', async () => {
  await mount()
  drop('C:\videos\a.mp4')
  await tick()

  const button = [...container.querySelectorAll('button')].find(
    (element) => element.textContent?.trim() === '取消',
  )
  expect(button).toBeUndefined()
})

test('a refusal from the scan is shown as the sentence it came with', async () => {
  /** Dropping a PNG used to produce `Error invoking remote method
   *  'upload:scan': Error: ENOTDIR: not a directory, scandir '...'` -- the
   *  channel name and an errno. The main process now answers with a sentence,
   *  and this screen's job is to not decorate it. */
  scan.mockResolvedValue({
    ok: false,
    message: '「car_h64.png」是一個檔案，不是資料夾。',
  })
  await mount()
  drop()
  await tick()

  expect(container.textContent).toContain('「car_h64.png」是一個檔案')
  expect(container.textContent).not.toContain('ENOTDIR')
  expect(container.textContent).not.toContain('remote method')
})

test('more than one dropped item is refused rather than silently reduced to one', async () => {
  /** It used to take `files[0]` and ignore the rest. Four lessons vanishing while
   *  the screen looks like it worked is the kind of failure somebody finds three
   *  days later. */
  await mount()

  drop(SCANNED.folder, 5)
  await tick()

  expect(scan).not.toHaveBeenCalled()
  expect(container.textContent).toContain('5')
  expect(container.textContent).toContain('一次')
})

test('one dropped item still works', async () => {
  await mount()

  drop(SCANNED.folder, 1)
  await tick()

  expect(scan).toHaveBeenCalledWith(SCANNED.folder)
})
