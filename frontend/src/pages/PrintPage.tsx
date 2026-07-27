import { useEffect, useState } from 'preact/hooks'

import { api } from '../lib/api'
import type { PrintResult } from '../lib/types'
import '../styles/print.css'

interface TutorialStep {
  text: string
  image?: { src: string; alt: string }
}

const steps: TutorialStep[] = [
  {
    text: '在首頁「列印／掃描」下方點選「取件編號列印」。',
    image: { src: '/assets/ibon_step1.png', alt: 'ibon 首頁的列印掃描選單，取件編號列印已標示' },
  },
  {
    text: '選擇「條碼辨識輸入」，讓 ibon 機台掃描上方 QR Code 後，選擇所有圖檔，然後預覽一下，沒問題就可以列印囉。',
    image: { src: '/assets/ibon_step2.png', alt: 'ibon 的條碼辨識輸入按鈕已標示' },
  },
  { text: '列印後記得拿著 ibon 跑出來的小白紙到櫃台結帳喔！' },
]

/** ibon pincode QR codes use a 29x29 viewBox; keep a two-module quiet zone. */
function trimQuietZone(svg: string): string {
  return svg.replace('viewBox="0 0 29 29"', 'viewBox="2 2 25 25"')
}

export function PrintPage({ id }: { id: string }) {
  const [result, setResult] = useState<PrintResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [zoomed, setZoomed] = useState<{ src: string; alt: string } | null>(null)

  useEffect(() => {
    let cancelled = false
    setResult(null)
    setError(null)
    api<PrintResult>(`/api/print/${encodeURIComponent(id)}`)
      .then((data) => {
        if (!cancelled) setResult(data)
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : '無法取得取件編號')
      })
    return () => {
      cancelled = true
    }
  }, [id])

  useEffect(() => {
    if (!zoomed) return undefined
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setZoomed(null)
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [zoomed])

  useEffect(() => {
    document.title = 'ibon 取件編號 | Luma Studio'
  }, [])

  return (
    <main>
      <div class="brand">
        <img src="/assets/luma-studio-logo.png" alt="Luma Studio 南光繪誌" />
      </div>

      {error !== null && (
        <section class="panel notice" aria-live="polite">
          <p class="notice-title">無法取得取件編號</p>
          <p class="notice-detail">{error}</p>
        </section>
      )}

      {error === null && result === null && (
        <section class="panel notice" aria-live="polite">
          <p class="notice-title">正在向 ibon 建立取件編號…</p>
          <p class="notice-detail">第一次建立需要上傳圖檔，請稍候。</p>
        </section>
      )}

      {result !== null && (
        <section class="panel" aria-label="ibon 取件資訊">
          <div class="qr-wrap">
            <div class="qr" aria-label="ibon 取件 QR Code" dangerouslySetInnerHTML={{ __html: trimQuietZone(result.qrCodeSvg) }} />
          </div>
          <div class="code-block">
            <span class="code-label">取件編號</span>
            <strong class="pincode" aria-label={`取件編號 ${result.pincode}`}>
              {[...result.pincode].map((digit, index) => (
                <span key={`${digit}-${index}`} aria-hidden="true">
                  {digit}
                </span>
              ))}
            </strong>
            <div class="details">
              <p>
                <strong>列印期限：</strong>
                {result.deadline}
              </p>
              <p>
                <strong>列印規格：</strong>
                {result.printSpec || '未預選規格'}
              </p>
              <p>
                <strong>圖檔數量：</strong>
                {result.files.length} 個
              </p>
            </div>
          </div>

          <section class="tutorial" aria-labelledby="tutorial-title">
            <h2 id="tutorial-title">列印教學</h2>
            <p>前往 7-ELEVEN 的 ibon 機台，依序完成以下步驟。</p>
            <ol class="tutorial-list">
              {steps.map((step) => (
                <li key={step.text}>
                  <div class="tutorial-step">{step.text}</div>
                  {step.image && (
                    <img
                      class="tutorial-image"
                      src={step.image.src}
                      alt={step.image.alt}
                      role="button"
                      tabIndex={0}
                      onClick={() => setZoomed(step.image ?? null)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault()
                          setZoomed(step.image ?? null)
                        }
                      }}
                    />
                  )}
                </li>
              ))}
            </ol>
          </section>
        </section>
      )}

      {zoomed && (
        <div class="lightbox" role="dialog" aria-modal="true" aria-label="教學圖片放大瀏覽" onClick={() => setZoomed(null)}>
          <img src={zoomed.src} alt={zoomed.alt} />
        </div>
      )}
    </main>
  )
}
