import { useEffect, useState } from 'preact/hooks'

// The licence FFmpeg's GPL builds ship, bundled rather than read from disk.
//
// It used to be read from the FFmpeg install at the moment the window opened,
// which fails on every machine that has not transcoded yet — and the failure was
// a panel that said 讀取中 for ever. Bundling it removes the failure mode
// entirely: the text is part of this build, so it is always there.
//
// It is a verbatim copy of the LICENSE from a gyan.dev GPL build, which is what
// `PINNED` in `shared/ffmpegRelease.ts` points at. If that pin ever moves to a
// build under different terms — an LGPL one, say — this file has to move with
// it. That is the one thing about it that can go wrong.
import licence from './ffmpeg-licence.txt?raw'

/**
 * Version, and the licence of the FFmpeg this tool ships.
 *
 * The licence is an obligation rather than a credit. FFmpeg is GPL and this tool
 * distributes a copy of it, so the terms have to be readable and the
 * corresponding source has to be reachable — and shipping them is only half of
 * it: somebody has to get to them without reading the repository.
 *
 * Both used to be absolute Windows paths printed in the footer, which satisfied
 * that and looked like a stack trace. Now the terms are shown, and the source is
 * a button that opens the folder it sits in. Neither path is written anywhere on
 * screen and both are one click away, which is the part that matters — a path
 * nobody can act on is not access.
 */
export function About() {
  const [version, setVersion] = useState('')
  const [showing, setShowing] = useState(false)

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

  return (
    <>
      <footer class="shell about">
        {/* One row. The way to the licence is not a call to action — it is
            there for the person who comes looking for it, so it reads like the
            version beside it rather than like something to press. */}
        <div class="row">
          <span class="muted">版本 {version || '讀取中'}</span>
          <button type="button" class="linkish muted" onClick={() => setShowing(true)}>
            FFmpeg 授權條款
          </button>
        </div>
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
              <button
                type="button"
                class="icon-button static"
                aria-label="關閉"
                title="關閉"
                onClick={() => setShowing(false)}
              >
                ✕
              </button>
            </div>
            {/* A read-only textarea rather than a `<pre>`: it scrolls, selects
                and copies the way anybody expects text in a box to, and its
                height is stated in lines so the panel cannot outgrow the
                window it opens over. */}
            <textarea class="licence" readOnly rows={20} spellcheck={false} value={licence} />
            <div class="row">
              <span class="muted">轉檔使用 FFmpeg，授權為 GPL。</span>
              <button
                type="button"
                class="linkish muted"
                onClick={() => void window.desktop.revealSource()}
              >
                開啟原始碼所在資料夾
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
