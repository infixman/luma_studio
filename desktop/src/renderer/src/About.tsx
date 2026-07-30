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
import { PINNED } from '../../shared/ffmpegRelease'

/**
 * Version, and the licence of the FFmpeg this tool ships.
 *
 * The licence is an obligation rather than a credit. FFmpeg is GPL and this tool
 * distributes a copy of it, so the terms have to be readable and the
 * corresponding source has to be reachable — and shipping them is only half of
 * it: somebody has to get to them without reading the repository.
 *
 * The terms are shown rather than pointed at: they used to be two absolute
 * Windows paths printed in the footer, which satisfied nothing and looked like a
 * stack trace.
 *
 * There is no "open the corresponding source" button. There was, and it pointed
 * at an archive this tool never downloads, so pressing it did nothing. The source
 * obligation begins when a binary is conveyed to somebody else, and this tool is
 * installed by the two admins who own it — so what belongs here is which build it
 * is and where it came from, which is true, instead of a button that implies an
 * obligation has been met.
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
            {/* Which build, and where it came from. There was a button here
                offering to open the corresponding source; it pointed at a file
                this tool never downloads, so it did nothing — and a button that
                pretends an obligation is met is worse than no button.
                See the note in the phase 4 task list: the source obligation
                begins when the installer reaches somebody outside, and this tool
                is used by the two admins who own it. */}
            <p class="muted">
              轉檔使用 FFmpeg {PINNED.version || '（版本未設定）'}，授權為 GPL。
              這是 gyan.dev 的 release build，對應的 FFmpeg 原始碼為上游 commit{' '}
              <code>38b88335f9</code>。
            </p>
          </div>
        </div>
      )}
    </>
  )
}
