import { useEffect, useRef, useState } from 'preact/hooks'

import { PasteIcon } from './Icons'
import { CODE_LENGTH, normaliseCode, problemWith } from '../../shared/pairing'
import type { SessionStatus } from '../../shared/session'

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
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Which code was last sent. A code is spent by the attempt, so the automatic
  // submit below must not fire twice for the same digits — otherwise editing the
  // field after a refusal would spend the attempt limit a keystroke at a time.
  const attempted = useRef('')

  // The address as it is *now*, not as it was when this render began. The
  // automatic submit runs from inside the code field's handler, and pasting both
  // fields in quick succession would otherwise check against a stale value and
  // decline to submit.
  const latestEmail = useRef('')

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
      setProblem(local)
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
      setProblem(result.message ?? '配對失敗')
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
        onSubmit={(event) => {
          event.preventDefault()
          void pair(code)
        }}
      >
        {/* A div rather than a label wrapping everything: the checkbox has its
            own label, and a label inside a label is not valid and makes the
            click target ambiguous. */}
        <div class="field">
          <label for="admin-email">管理者信箱</label>
          <div class="field-row">
            <div class="with-action">
              <input
                id="admin-email"
                type="email"
                value={email}
                autoComplete="off"
                spellcheck={false}
                disabled={busy}
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
        </div>

        <div class="field">
          <label for="pairing-code">驗證碼</label>
          <div class="with-action code-field">
            <input
              id="pairing-code"
              // Not `type="number"`: it strips leading zeros and offers a spinner
              // for something that is not a quantity.
              type="text"
              inputMode="numeric"
              value={code}
              // Room for the space the back office renders, so pasting `418 302`
              // is not silently truncated to five digits.
              maxLength={CODE_LENGTH + 4}
              autoComplete="off"
              spellcheck={false}
              disabled={busy}
              class="code-input"
              onInput={(event) => onCode((event.currentTarget as HTMLInputElement).value)}
            />
            <button
              type="button"
              class="icon-button"
              title="貼上"
              aria-label="貼上驗證碼"
              disabled={busy}
              onClick={() => void pasteInto(onCode)}
            >
              <PasteIcon />
            </button>
          </div>
        </div>

        {problem && (
          <p class="alert" role="alert">
            {problem}
          </p>
        )}

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
