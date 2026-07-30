import { useEffect, useState } from 'preact/hooks'

/**
 * Version, and the licence of the FFmpeg this tool ships.
 *
 * The second part is an obligation rather than a credit. FFmpeg is GPL and this
 * tool distributes a copy of it, so the licence and the corresponding source
 * ship with it — and shipping them is only half of it: somebody has to be able
 * to reach them without reading the repository.
 *
 * Two absolute Windows paths printed in a footer satisfied that and looked like
 * a stack trace. So the licence is *shown* instead, in a window over the page,
 * and the source is a button that opens the folder it is in. Neither path is
 * written down anywhere on screen, and both are still one click away — which is
 * the part that matters, since a path nobody can act on is not access.
 *
 * The text is fetched when the window opens rather than on mount. It is around a
 * hundred kilobytes that almost nobody reads.
 */
export function About() {
  const [version, setVersion] = useState('')
  const [showing, setShowing] = useState(false)
  const [licence, setLicence] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    void window.desktop.version().then(setVersion)
  }, [])

  useEffect(() => {
    if (!showing) return
    // Escape, because a panel over the page that only closes by aiming at a
    // small button is a panel people feel stuck in.
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setShowing(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [showing])

  function open(): void {
    setShowing(true)
    if (licence !== null || missing) return
    void window.desktop.licenceText().then((text) => {
      if (text === null) setMissing(true)
      else setLicence(text)
    })
  }

  return (
    <>
      <footer class="shell about">
        <p class="muted">版本 {version || '讀取中'}</p>
        <button type="button" class="ghost" onClick={open}>
          FFmpeg 授權條款
        </button>
      </footer>

      {showing && (
        <div
          class="overlay"
          role="dialog"
          aria-modal="true"
          aria-label="FFmpeg 授權條款"
          // Clicking the backdrop closes it; clicking the panel must not, which
          // is what the target check is for.
          onClick={(event) => {
            if (event.target === event.currentTarget) setShowing(false)
          }}
        >
          <div class="sheet">
            <div class="row">
              <strong>FFmpeg 授權條款</strong>
              <button type="button" class="icon-button static" aria-label="關閉" title="關閉"
                onClick={() => setShowing(false)}>
                ✕
              </button>
            </div>
            {missing ? (
              <p class="muted">
                FFmpeg 還沒下載到這台機器，所以條款檔案還不在。第一次轉檔時會一起取得。
              </p>
            ) : licence === null ? (
              <p class="muted">讀取中</p>
            ) : (
              <pre class="licence">{licence}</pre>
            )}
            <p class="muted">
              轉檔使用 FFmpeg，授權為 GPL。對應的原始碼隨工具一起提供。
            </p>
            <button type="button" class="ghost" onClick={() => void window.desktop.revealSource()}>
              開啟原始碼所在資料夾
            </button>
          </div>
        </div>
      )}
    </>
  )
}
