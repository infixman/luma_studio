import { useState } from 'preact/hooks'

import { CODE_LENGTH, problemWith } from '../../shared/pairing'
import type { SessionStatus } from '../../shared/session'

/**
 * Where somebody types the code the back office is showing them.
 *
 * Two things here exist to avoid a specific wrong impression.
 *
 * The code is checked for shape before it is sent, because a six-digit code has
 * an attempt limit and submitting an obviously wrong one spends part of it. A
 * tool that locks its own admin out by being helpful is worse than one that
 * says "that is five digits".
 *
 * And the machines with no OS encryption are told so, rather than left to
 * discover that pairing does not stick. See `main/store.ts` — nothing is written
 * in the clear.
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
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: Event) {
    event.preventDefault()
    const local = problemWith({ email, code })
    if (local) {
      setProblem(local)
      return
    }

    setBusy(true)
    setProblem(null)
    try {
      const result = await window.desktop.auth.pair({ email, code })
      if (result.ok && result.status) {
        onPaired(result.status)
        return
      }
      setProblem(result.message ?? '配對失敗')
      // The code is spent either way, so clearing it stops somebody hammering
      // the same wrong digits into the attempt limit.
      setCode('')
    } finally {
      setBusy(false)
    }
  }

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

      <form onSubmit={submit} class="stack">
        <label>
          <span>管理者信箱</span>
          <input
            type="email"
            value={email}
            autoComplete="off"
            spellcheck={false}
            disabled={busy}
            onInput={(event) => setEmail((event.currentTarget as HTMLInputElement).value)}
          />
        </label>

        <label>
          <span>驗證碼</span>
          <input
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
            onInput={(event) => setCode((event.currentTarget as HTMLInputElement).value)}
          />
        </label>

        {problem && (
          <p class="alert" role="alert">
            {problem}
          </p>
        )}

        <button type="submit" disabled={busy || Boolean(status.endpointProblem)}>
          {busy ? '配對中…' : '配對'}
        </button>
      </form>

      {!status.remembered && (
        <p class="muted">
          這台機器的作業系統沒有提供加密儲存，所以配對不會被記住 —— 每次啟動都要再輸入一次。
          （比把憑證明文寫在硬碟上好。）
        </p>
      )}

      <p class="muted">驗證碼每 30 秒更換，而且用過一次就失效。</p>
    </main>
  )
}
