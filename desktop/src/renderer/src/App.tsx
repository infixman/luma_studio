import { useEffect, useState } from 'preact/hooks'

/**
 * The skeleton. It draws a window and reports its own version, and that is the
 * whole of it — pairing is the next step, uploading the one after.
 *
 * Kept as its own step because the things most likely to go wrong about an
 * Electron app are not features: whether it builds, whether the preload bridge
 * arrives, whether the packaged copy can find its own files. Those are cheaper
 * to find now than underneath a half-finished uploader.
 */
export function App() {
  const [version, setVersion] = useState('')

  useEffect(() => {
    void window.desktop.version().then(setVersion)
  }, [])

  return (
    <main class="shell">
      <h1>苒光繪誌 影片上傳工具</h1>
      <p class="muted">
        課程影片在這台機器上轉檔，再直接上傳。這個工具沒有 R2 金鑰 —— 它會向管理後端
        取得一組只能做影片操作的短效憑證。
      </p>
      <p class="muted">版本 {version || '讀取中'}</p>
    </main>
  )
}
