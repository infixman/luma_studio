import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

import { AdminShell } from '../components/AdminShell'
import { useStatus } from '../components/StatusBar'
import { Button, Checkbox, IconButton, Panel, Spinner, TextField } from '../components/ui'
import { ApiError, api, apiJson } from '../../shared/api'
import type { DesktopVersionPolicy } from '../../shared/types'
import '../styles/shop-admin.css'

/**
 * Copy a value, and say so.
 *
 * Both of these get typed into another window, and the code has a thirty-second
 * life — a copy button is the difference between reading six digits off a screen
 * and having them. The confirmation matters as much: without it somebody presses
 * it twice and pastes nothing the second time, having no idea whether it worked.
 */
function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <IconButton
      label={copied ? '已複製' : label}
      size="sm"
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true)
          // Long enough to be seen, short enough that the button is ready again
          // before the next code arrives.
          setTimeout(() => setCopied(false), 1_500)
        })
      }}
    >
      {copied ? '✓' : '⧉'}
    </IconButton>
  )
}

/**
 * Which builds of the tool may work.
 *
 * The trap this exists for: 1.0.0 installed with a broken updater is a fix
 * nobody can push. So the two levers are here before the first release, and they
 * are separate because they answer different questions — `minSupported` retires
 * versions as they age, `blocked` stops every one of them at once.
 *
 * The download link is the feed the server itself reports rather than a URL
 * typed here. A link that says where the installer *should* be is a link that is
 * wrong on whichever deployment is not production.
 */
function VersionPolicyPanel({ onError }: { onError: (error: unknown) => void }) {
  const [policy, setPolicy] = useState<DesktopVersionPolicy | null>(null)
  const [draft, setDraft] = useState<DesktopVersionPolicy | null>(null)
  const { message, busy, run } = useStatus()

  const load = useCallback(async () => {
    try {
      const answer = await api<DesktopVersionPolicy>('/api/desktop/version-policy')
      setPolicy(answer)
      setDraft(answer)
    } catch (error) {
      onError(error)
    }
  }, [onError])

  useEffect(() => {
    void load()
  }, [load])

  if (draft === null) return <Panel title="版本政策"><Spinner /></Panel>

  return (
    <Panel title="版本政策">
      <p class="muted">
        比「最低支援版本」舊的工具會停止上傳並要求更新。「停用」則是<strong>所有</strong>版本立刻停下來 ——
        那是給一個發壞了的版本用的，不必等每一台機器自己更新。
      </p>

      <div class="ui-inline-form">
        <TextField
          label="最新版本"
          value={draft.latest}
          onInput={(event) =>
            setDraft({ ...draft, latest: (event.currentTarget as HTMLInputElement).value })
          }
        />
        <TextField
          label="最低支援版本"
          value={draft.minSupported}
          onInput={(event) =>
            setDraft({ ...draft, minSupported: (event.currentTarget as HTMLInputElement).value })
          }
        />
      </div>

      <Checkbox
        label="必須更新到最新版才能使用"
        checked={draft.forceUpdate}
        onChange={(next) => setDraft({ ...draft, forceUpdate: next })}
      />
      <Checkbox
        label="停用所有版本"
        checked={draft.blocked}
        onChange={(next) => setDraft({ ...draft, blocked: next })}
      />

      <TextField
        label="說明"
        hint="會顯示在工具裡，說明為什麼要更新"
        value={draft.notes}
        maxLength={200}
        onInput={(event) =>
          setDraft({ ...draft, notes: (event.currentTarget as HTMLInputElement).value })
        }
      />

      <Button
        tone="primary"
        busy={busy}
        onClick={() => {
          void run(async () => {
            await apiJson('/api/desktop/version-policy', 'PUT', {
              latest: draft.latest.trim(),
              minSupported: draft.minSupported.trim(),
              forceUpdate: draft.forceUpdate,
              blocked: draft.blocked,
              notes: draft.notes,
            })
          }, '版本政策已更新。').then((ok) => {
            if (ok) void load()
          })
        }}
      >
        儲存
      </Button>

      {message ? <p class={message.kind === 'error' ? 'alert' : 'muted'}>{message.text}</p> : null}

      <h3>下載</h3>
      <p class="muted">
        安裝檔與更新 metadata 都在這個位置底下，由伺服器自己回報 —— 不是這裡打上去的網址。
      </p>
      <p>
        <a href={`${policy?.feedUrl ?? ''}/latest.yml`} rel="noopener noreferrer">
          {policy?.feedUrl ?? ''}/latest.yml
        </a>
      </p>
      <p class="muted">
        安裝檔沒有簽章，所以 Windows SmartScreen 會跳警告 —— 選「其他資訊」再「仍要執行」。
        買一張憑證不在這個專案的預算裡，而這件事寫在 README 與這裡，因為它看起來像出了問題。
      </p>
    </Panel>
  )
}

interface PairingCode {
  code: string
  expiresInSeconds: number
  adminEmail: string
}

/**
 * The pairing code the desktop uploader asks for.
 *
 * This page *is* the authorisation. The code is not secret in any deep sense —
 * the server both generates and verifies it — so the only thing that makes
 * showing one meaningful is that a stranger cannot see this screen.
 *
 * There used to be a line here warning against sharing it. It went: a code with
 * a visible thirty-second countdown beside it does not need a paragraph saying
 * it expires, and an admin reading their own back office is not the audience for
 * a lecture. The countdown says the same thing by being true.
 *
 * The countdown comes from the server's remaining seconds rather than a local
 * 30-second timer. A timer started on load drifts out of step with the window
 * it is describing, and the failure looks like a correct code being rejected.
 */
export function DesktopToolPage() {
  const [pairing, setPairing] = useState<PairingCode | null>(null)
  const [remaining, setRemaining] = useState(0)
  const [unconfigured, setUnconfigured] = useState(false)
  const { message, showError } = useStatus()

  // A load in flight when the page closes must not set state afterwards, and a
  // slow one must not overwrite a newer code.
  const generation = useRef(0)

  const load = useCallback(async () => {
    const mine = ++generation.current
    try {
      const next = await api<PairingCode>('/api/desktop/pairing-code')
      if (mine !== generation.current) return
      setPairing(next)
      setRemaining(next.expiresInSeconds)
      setUnconfigured(false)
    } catch (error) {
      if (mine !== generation.current) return
      // 503 is not a fault to report as one: it means the Worker has no
      // pairing secret yet, which is a thing to go and do.
      if (error instanceof ApiError && error.status === 503) {
        setUnconfigured(true)
        return
      }
      showError(error)
    }
  }, [showError])

  useEffect(() => {
    void load()
    return () => {
      // Any answer still in flight belongs to a page that has gone.
      generation.current++
    }
  }, [load])

  useEffect(() => {
    if (pairing === null || unconfigured) return
    const tick = setInterval(() => {
      setRemaining((left) => {
        if (left > 1) return left - 1
        // Fetch the next window rather than computing it. The code is derived
        // from a seed this page does not have.
        void load()
        return 0
      })
    }, 1000)
    return () => clearInterval(tick)
  }, [pairing, unconfigured, load])

  return (
    <AdminShell current="/desktop-tool" message={message} onError={showError}>
      <Panel title="配對驗證碼">
        {unconfigured ? (
          <p class="muted">
            這個環境還沒有設定 <code>DESKTOP_PAIRING_SECRET</code>，所以無法產生驗證碼。
            設定之後重新整理即可。
          </p>
        ) : pairing === null ? (
          <Spinner />
        ) : (
          <>
            <p class="muted">在桌面工具的登入畫面輸入這組信箱與驗證碼。</p>
            <dl class="desktop-pairing">
              <dt>管理者信箱</dt>
              <dd class="copyable">
                <code>{pairing.adminEmail}</code>
                <CopyButton value={pairing.adminEmail} label="複製信箱" />
              </dd>
              <dt>驗證碼</dt>
              <dd class="copyable">
                {/* Not grouped and not oversized. It is read once and copied,
                    not memorised across a room, and the same `code` treatment as
                    the address above keeps the two rows the same shape. */}
                <code
                  class="desktop-pairing-code"
                  aria-label={`驗證碼 ${pairing.code.split('').join(' ')}`}
                >
                  {pairing.code}
                </code>
                <CopyButton value={pairing.code} label="複製驗證碼" />
              </dd>
              <dt>剩餘時間</dt>
              <dd aria-live="polite">{remaining} 秒</dd>
            </dl>
          </>
        )}
      </Panel>

      <VersionPolicyPanel onError={showError} />
    </AdminShell>
  )
}
