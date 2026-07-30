import { useEffect, useRef, useState } from 'preact/hooks'

import { looksLikeSource } from '../../shared/sourceKinds'
import type { Progress, ScannedFolder } from '../../shared/upload'

const PHASE_LABELS: Record<Progress['phase'], string> = {
  preparing: '準備轉檔工具',
  probing: '讀取影片資訊',
  encoding: '轉檔中',
  poster: '產生封面',
  writing: '寫出播放清單',
  scanning: '讀取資料夾',
  creating: '建立影片項目',
  uploading: '上傳中',
  registering: '驗證中',
  done: '完成',
  failed: '未完成',
}

/** Nothing to count during a transcode, so the bar reads `fraction` instead. */
function barWidth(progress: Progress): number | null {
  if (typeof progress.fraction === 'number') return Math.round(progress.fraction * 100)
  if (progress.total > 0) return Math.round((progress.uploaded / progress.total) * 100)
  return null
}

function readableSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

/**
 * Dropping a folder of encoded output and watching it go up.
 *
 * This step uploads; it does not transcode. The input is a directory the
 * PowerShell script produced, which is deliberate — the integration is the risky
 * part, and it is cheaper to exercise with output already known to be correct.
 *
 * `registering` is shown as a phase of its own rather than folded into
 * uploading, because it is the step that decides whether the video plays. An
 * upload that finished and a video that works are different claims, and the
 * server checks every object before making the second one.
 */
export function UploadScreen({ adminEmail, onSignOut }: { adminEmail: string; onSignOut: () => void }) {
  const [scanned, setScanned] = useState<ScannedFolder | null>(null)
  const [source, setSource] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [progress, setProgress] = useState<Progress | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const busy = progress !== null && !['done', 'failed'].includes(progress.phase)

  // Subscribed once. Re-subscribing on every render would stack listeners and
  // the progress bar would jump about.
  const unsubscribe = useRef<(() => void) | null>(null)
  useEffect(() => {
    unsubscribe.current = window.desktop.upload.onProgress(setProgress)
    return () => unsubscribe.current?.()
  }, [])

  async function choose(path: string) {
    setProblem(null)
    setProgress(null)
    setScanned(null)
    setSource(null)

    // An MP4 is transcoded here; a folder is output somebody already produced.
    // Both are accepted, and the difference is only which phases run.
    if (looksLikeSource(path)) {
      setSource(path)
      return
    }

    try {
      const next = await window.desktop.upload.scan(path)
      setScanned(next)
      if (next.objects.length === 0) {
        setProblem(
          '這裡面找不到轉檔輸出，也不是影片檔。可以拖一個 MP4 進來轉檔，' +
            '或是拖一個已經有 master.m3u8 的資料夾。',
        )
      }
    } catch (error) {
      setProblem(error instanceof Error ? error.message : '無法讀取這個路徑')
    }
  }

  const zone = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const element = zone.current
    if (!element) return

    const over = (event: Event): void => {
      // Without this the window navigates to the dropped file instead.
      event.preventDefault()
      setDragging(true)
    }
    const leave = (): void => setDragging(false)
    const dropped = (event: Event): void => {
      event.preventDefault()
      setDragging(false)
      const [file] = [...((event as DragEvent).dataTransfer?.files ?? [])]
      // Electron resolves this through `webUtils` in the preload; a browser
      // could not, and `File.path` no longer exists.
      const path = file ? window.desktop.pathFor(file) : ''
      if (path) void choose(path)
    }

    element.addEventListener('dragover', over)
    element.addEventListener('dragleave', leave)
    element.addEventListener('drop', dropped)
    return () => {
      element.removeEventListener('dragover', over)
      element.removeEventListener('dragleave', leave)
      element.removeEventListener('drop', dropped)
    }
  })

  async function start() {
    if (!source && (!scanned || scanned.objects.length === 0)) return
    setProblem(null)
    const result = await window.desktop.upload.start(
      source ? { source, title } : { folder: scanned!.folder, title },
    )
    if (!result.ok) {
      setProblem(result.message)
      setProgress(null)
      return
    }
    setProgress(result.result)
  }

  return (
    <main class="shell">
      {/* Who is signed in belongs next to the way out, not on a line of its own
          under the title where it reads as the first thing this screen has to
          say. It is context for the sign-out button. */}
      <header class="row">
        <h1>上傳課程影片</h1>
        <div class="row-left">
          <span class="muted">已連結 {adminEmail}</span>
          <button type="button" class="ghost" onClick={onSignOut} disabled={busy}>
            登出
          </button>
        </div>
      </header>

      {/* Listeners are attached below rather than as JSX props. Preact chooses
          between `addEventListener('drop')` and `addEventListener('Drop')` by
          whether `ondrop` happens to be a property of the element, which is not
          a decision worth depending on — this says the name outright. */}
      <div ref={zone} class={`drop ${dragging ? 'over' : ''}`}>
        <p>把高畫質 MP4 拖到這裡</p>
        <p class="muted">
          會在這台機器上轉出各畫質、分段，然後上傳。也可以拖一個已經轉好的資料夾，
          那樣會跳過轉檔直接上傳。
        </p>
      </div>

      {(source || (scanned && scanned.objects.length > 0)) && (
        <>
          <dl class="facts">
            <dt>{source ? '影片檔' : '資料夾'}</dt>
            <dd>
              <code>{source ?? scanned!.folder}</code>
            </dd>
            {scanned && !source && (
              <>
                <dt>檔案數</dt>
                <dd>{scanned.objects.length}</dd>
                <dt>總容量</dt>
                <dd>{readableSize(scanned.totalBytes)}</dd>
              </>
            )}
          </dl>

          {scanned && scanned.unexpected.length > 0 && (
            <p class="muted">
              有 {scanned.unexpected.length} 個檔案不屬於轉檔輸出，會被略過：
              {scanned.unexpected.slice(0, 3).join('、')}
              {scanned.unexpected.length > 3 ? ' …' : ''}
            </p>
          )}

          <label>
            <span>影片名稱</span>
            <input
              type="text"
              value={title}
              maxLength={200}
              disabled={busy}
              placeholder="第一課 起稿"
              onInput={(event) => setTitle((event.currentTarget as HTMLInputElement).value)}
            />
          </label>

          <div class="row-left">
            <button type="button" onClick={() => void start()} disabled={busy}>
              {busy ? '進行中…' : source ? '轉檔並上傳' : '開始上傳'}
            </button>
            {busy && (
              <button type="button" class="ghost" onClick={() => void window.desktop.upload.cancel()}>
                取消
              </button>
            )}
          </div>
        </>
      )}

      {progress && (
        <section class="progress" aria-live="polite">
          <p>
            {PHASE_LABELS[progress.phase]}
            {progress.rung ? `（${progress.rung}）` : ''}
            {progress.total > 0 && progress.phase === 'uploading'
              ? `：${progress.uploaded} / ${progress.total}`
              : ''}
          </p>
          {barWidth(progress) !== null && (
            <div class="bar">
              <div style={{ width: `${barWidth(progress)}%` }} />
            </div>
          )}
          {progress.message && <p class="muted">{progress.message}</p>}
          {progress.missing && progress.missing.length > 0 && (
            <ul class="missing">
              {progress.missing.slice(0, 10).map((path) => (
                <li key={path}>
                  <code>{path}</code>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {problem && (
        <p class="alert" role="alert">
          {problem}
        </p>
      )}
    </main>
  )
}
