import { useEffect, useState } from 'preact/hooks'

/**
 * Version, and where the bundled FFmpeg's licence and source are.
 *
 * The second part is an obligation rather than a credit. FFmpeg is GPL and this
 * tool distributes a copy of it, so the licence and the corresponding source
 * ship with it — and shipping them is only half of it: somebody has to be able
 * to find them without reading the repository.
 */
export function About() {
  const [version, setVersion] = useState('')
  const [licences, setLicences] = useState<{ licence: string; source: string } | null>(null)

  useEffect(() => {
    void window.desktop.version().then(setVersion)
    void window.desktop.licences().then(setLicences)
  }, [])

  return (
    <footer class="shell about">
      <p class="muted">
        版本 {version || '讀取中'}。這個工具沒有 R2 金鑰 —— 它拿到的是一組只能做影片操作的
        短效憑證。
      </p>
      <details>
        <summary class="muted">關於 FFmpeg 與授權</summary>
        <p class="muted">
          轉檔使用 FFmpeg，授權為 GPL。授權條文與對應的原始碼隨工具一起提供，路徑如下：
        </p>
        {licences ? (
          <dl class="facts">
            <dt>授權條文</dt>
            <dd>
              <code>{licences.licence}</code>
            </dd>
            <dt>原始碼</dt>
            <dd>
              <code>{licences.source}</code>
            </dd>
          </dl>
        ) : (
          <p class="muted">讀取中</p>
        )}
      </details>
    </footer>
  )
}
