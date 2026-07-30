import { useEffect, useRef, useState } from 'preact/hooks'

import type { Progress, ScannedFolder } from '../../shared/upload'

const PHASE_LABELS: Record<Progress['phase'], string> = {
  scanning: '讀取資料夾',
  creating: '建立影片項目',
  uploading: '上傳中',
  registering: '驗證中',
  done: '完成',
  failed: '未完成',
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

  async function choose(folder: string) {
    setProblem(null)
    setProgress(null)
    try {
      const next = await window.desktop.upload.scan(folder)
      setScanned(next)
      if (!title) {
        // The folder is named after the asset id, not the lesson, so this is a
        // starting point rather than an answer.
        setTitle('')
      }
      if (next.objects.length === 0) {
        setProblem('這個資料夾裡找不到轉檔輸出。應該要有 master.m3u8 和各畫質的資料夾。')
      }
    } catch (error) {
      setProblem(error instanceof Error ? error.message : '無法讀取這個資料夾')
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
    if (!scanned || scanned.objects.length === 0) return
    setProblem(null)
    const result = await window.desktop.upload.start({ folder: scanned.folder, title })
    if (!result.ok) {
      setProblem(result.message)
      setProgress(null)
      return
    }
    setProgress(result.result)
  }

  return (
    <main class="shell">
      <header class="row">
        <h1>上傳課程影片</h1>
        <button type="button" class="ghost" onClick={onSignOut} disabled={busy}>
          取消連結
        </button>
      </header>
      <p class="muted">已連結 {adminEmail}</p>

      {/* Listeners are attached below rather than as JSX props. Preact chooses
          between `addEventListener('drop')` and `addEventListener('Drop')` by
          whether `ondrop` happens to be a property of the element, which is not
          a decision worth depending on — this says the name outright. */}
      <div ref={zone} class={`drop ${dragging ? 'over' : ''}`}>
        <p>把轉檔輸出的資料夾拖到這裡</p>
        <p class="muted">
          資料夾裡應該有 master.m3u8、poster.webp，以及 1080p／720p／480p 的分段。
        </p>
      </div>

      {scanned && scanned.objects.length > 0 && (
        <>
          <dl class="facts">
            <dt>資料夾</dt>
            <dd>
              <code>{scanned.folder}</code>
            </dd>
            <dt>檔案數</dt>
            <dd>{scanned.objects.length}</dd>
            <dt>總容量</dt>
            <dd>{readableSize(scanned.totalBytes)}</dd>
          </dl>

          {scanned.unexpected.length > 0 && (
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

          <button type="button" onClick={() => void start()} disabled={busy}>
            {busy ? '上傳中…' : '開始上傳'}
          </button>
        </>
      )}

      {progress && (
        <section class="progress" aria-live="polite">
          <p>
            {PHASE_LABELS[progress.phase]}
            {progress.total > 0 && progress.phase === 'uploading'
              ? `：${progress.uploaded} / ${progress.total}`
              : ''}
          </p>
          {progress.total > 0 && (
            <div class="bar">
              <div style={{ width: `${Math.round((progress.uploaded / progress.total) * 100)}%` }} />
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
