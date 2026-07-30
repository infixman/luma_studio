import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'

import { CodeInput } from './CodeInput'
import { PasteIcon } from './Icons'
import { CODE_LENGTH, normaliseCode, problemWith } from '../../shared/pairing'
import type { PairingField } from '../../shared/pairing'
import type { SessionStatus } from '../../shared/session'

/** Matches --revert-hold in the stylesheet: after this the error fades out. */
const REVERT_HOLD_MS = 3_000

/**
 * Where somebody types the code the back office is showing them.
 *
 * Three things here exist to avoid a specific wrong impression.
 *
 * The code is checked for shape before it is sent, because a six-digit code has
 * an attempt limit and submitting an obviously wrong one spends part of it. A
 * tool that locks its own admin out by being eager is worse than one that says
 * "that is five digits".
 *
 * Machines with no OS encryption are told so, rather than left to discover that
 * pairing does not stick. See `main/store.ts` — nothing is written in the clear.
 *
 * And the email can be remembered while the token cannot. They are different
 * kinds of thing: one is a convenience, the other a credential.
 */
export function PairingScreen({
  status,
  onPaired,
}: {
  status: SessionStatus
  onPaired: (next: SessionStatus) => void
}) {
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [remember, setRemember] = useState(false)
  const [problem, setProblem] = useState<{ field: PairingField; message: string } | null>(null)
  const [busy, setBusy] = useState(false)

  // The two wrappers that shake. Held as elements rather than driven by a class
  // in the render, because restarting a CSS animation needs the class gone, a
  // reflow, and the class back -- and Preact re-rendering with the same class
  // does none of that, so the second wrong address would not move at all.
  const wraps = useRef<Record<PairingField, HTMLDivElement | null>>({ email: null, code: null })
  const revert = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Counts refusals rather than describing one. Two identical refusals in a row
  // have to shake twice, and any state that says "the email is wrong" is equal to
  // itself the second time.
  const [shakes, setShakes] = useState(0)

  /**
   * Start the shake after the DOM has been updated, not during the handler.
   *
   * The class is added imperatively because restarting a CSS animation needs the
   * class gone, a reflow, and the class back — a re-render with the same class
   * does none of that. But doing it inside the handler puts it before Preact
   * rewrites the wrapper's `class` attribute for the new error state, which wipes
   * it: the field turned red and stood perfectly still.
   */
  useLayoutEffect(() => {
    if (shakes === 0 || !problem) return
    const shaking = wraps.current[problem.field]?.querySelector('.t-input')
    if (!shaking) return
    shaking.classList.remove('is-shaking')
    // Reading a layout property is what forces the reflow. Without it the
    // browser collapses remove-then-add into no change at all.
    void (shaking as HTMLElement).offsetWidth
    shaking.classList.add('is-shaking')
  }, [shakes, problem])

  function reject(field: PairingField, message: string): void {
    setProblem({ field, message })
    setShakes((count) => count + 1)

    // Reverts on the hold timer, so the border and the message fade out together
    // rather than staying red until the next attempt.
    if (revert.current) clearTimeout(revert.current)
    revert.current = setTimeout(() => setProblem(null), REVERT_HOLD_MS)
  }

  // Which code was last sent. A code is spent by the attempt, so the automatic
  // submit below must not fire twice for the same digits — otherwise editing the
  // field after a refusal would spend the attempt limit a keystroke at a time.
  const attempted = useRef('')

  // The address as it is *now*, not as it was when this render began. The
  // automatic submit runs from inside the code field's handler, and pasting both
  // fields in quick succession would otherwise check against a stale value and
  // decline to submit.
  const latestEmail = useRef('')

  // A refusal seconds before the window closes would otherwise set state on a
  // component that has gone.
  useEffect(() => () => {
    if (revert.current) clearTimeout(revert.current)
  }, [])

  useEffect(() => {
    void window.desktop.prefs.read().then(({ rememberedEmail }) => {
      if (!rememberedEmail) return
      setEmail(rememberedEmail)
      latestEmail.current = rememberedEmail
      setRemember(true)
    })
  }, [])

  async function pair(withCode: string, withEmail: string = latestEmail.current) {
    const local = problemWith({ email: withEmail, code: withCode })
    if (local) {
      reject(local.field, local.message)
      return
    }

    attempted.current = normaliseCode(withCode)
    setBusy(true)
    setProblem(null)
    try {
      // Written before the attempt, so a successful pairing does not have to
      // remember to do it and a failed one still keeps the address typed.
      await window.desktop.prefs.rememberEmail(remember ? withEmail.trim() : '')

      const result = await window.desktop.auth.pair({ email: withEmail, code: withCode })
      if (result.ok && result.status) {
        onPaired(result.status)
        return
      }
      // Against the code: whatever the server's reason, the digits are what it
      // refused and they are what has to be typed again.
      reject('code', result.message ?? '配對失敗')
      // Spent either way, so clearing it stops somebody hammering the same wrong
      // digits into the attempt limit.
      setCode('')
    } finally {
      setBusy(false)
    }
  }

  /**
   * Submit as soon as six digits are in, if there is an address to send with
   * them.
   *
   * The code is short-lived and typed by hand, so a separate button press is a
   * step that only ever costs seconds off the window. Guarded by `attempted` so
   * it fires once per distinct code rather than on every keystroke after the
   * sixth.
   */
  function onEmail(value: string) {
    latestEmail.current = value
    setEmail(value)
  }

  function onCode(raw: string) {
    setCode(raw)
    const digits = normaliseCode(raw)
    const ready = digits.length === CODE_LENGTH && /^[0-9]+$/.test(digits)
    if (ready && latestEmail.current.trim() && !busy && attempted.current !== digits) {
      void pair(raw, latestEmail.current)
    }
  }

  async function pasteInto(set: (value: string) => void) {
    const text = await window.desktop.clipboard()
    if (text) set(text.trim())
  }

  const blocked = Boolean(status.endpointProblem)

  return (
    <main class="shell">
      <h1>連結管理後台</h1>
      <p class="muted">
        在後台的「桌面上傳工具」頁面上會顯示一組驗證碼。輸入你的管理者信箱和那組數字。
      </p>

      {status.endpointProblem && (
        <p class="alert" role="alert">
          {status.endpointProblem}
        </p>
      )}

      <form
        class="stack"
        // The browser's own bubble for `type="email"` is a yellow tooltip in the
        // OS font that appears over whatever is under it and says things like
        // 「未包含『@』」. This screen marks the field and says its own sentence, so
        // the native one is turned off rather than shown alongside.
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          void pair(code)
        }}
      >
        {/* A div rather than a label wrapping everything: the checkbox has its
            own label, and a label inside a label is not valid and makes the
            click target ambiguous. */}
        <div
          class={`field t-input-wrap ${problem?.field === 'email' ? 'is-error' : ''}`}
          ref={(element) => {
            wraps.current.email = element
          }}
        >
          <label for="admin-email">管理者信箱</label>
          <div class="field-row">
            <div class={`with-action t-input ${problem?.field === 'email' ? 'is-error' : ''}`}>
              <input
                id="admin-email"
                type="email"
                value={email}
                autoComplete="off"
                spellcheck={false}
                disabled={busy}
                aria-invalid={problem?.field === 'email'}
                onInput={(event) => onEmail((event.currentTarget as HTMLInputElement).value)}
              />
              <button
                type="button"
                class="icon-button"
                title="貼上"
                aria-label="貼上信箱"
                disabled={busy}
                onClick={() => void pasteInto(onEmail)}
              >
                <PasteIcon />
              </button>
            </div>
            {/* Beside the field it is about, rather than under it where it reads
                as a separate question. */}
            <span class="check">
              <input
                id="remember-email"
                type="checkbox"
                checked={remember}
                disabled={busy}
                onChange={(event) => setRemember((event.currentTarget as HTMLInputElement).checked)}
              />
              <label for="remember-email">記住信箱</label>
            </span>
          </div>
          {/* Always rendered, so the fade has something to fade. `role="alert"`
              is what makes the shake mean anything to a screen reader, which
              cannot see a thing move. */}
          <p class="t-error-msg" role="alert">
            {problem?.field === 'email' ? problem.message : ''}
          </p>
        </div>

        <div
          class={`field t-input-wrap ${problem?.field === 'code' ? 'is-error' : ''}`}
          ref={(element) => {
            wraps.current.code = element
          }}
        >
          <span class="field-label">驗證碼</span>
          <div class={`field-row t-input ${problem?.field === 'code' ? 'is-error' : ''}`}>
            <CodeInput value={code} disabled={busy} onChange={onCode} />
            <button
              type="button"
              class="icon-button static"
              title="貼上"
              aria-label="貼上驗證碼"
              disabled={busy}
              onClick={() => void pasteInto(onCode)}
            >
              <PasteIcon />
            </button>
          </div>
          <p class="t-error-msg" role="alert">
            {problem?.field === 'code' ? problem.message : ''}
          </p>
        </div>

        <button type="submit" disabled={busy || blocked}>
          {busy ? '配對中…' : '配對'}
        </button>
      </form>

      {!status.remembered && (
        <p class="muted">
          這台機器的作業系統沒有提供加密儲存，所以配對不會被記住 —— 每次啟動都要再輸入一次。
          （比把憑證明文寫在硬碟上好。）
        </p>
      )}
    </main>
  )
}
