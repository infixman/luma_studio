import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

import { AdminShell } from '../components/AdminShell'
import { useStatus } from '../components/StatusBar'
import {
  Badge,
  Button,
  Checkbox,
  DataTable,
  EmptyState,
  IconButton,
  Menu,
  MenuItem,
  Panel,
  Spinner,
  TextField,
  useConfirm,
} from '../components/ui'
import type { Column } from '../components/ui'
import { ApiError, api, apiJson } from '../../shared/api'
import { dateTime } from '../../shared/dates'
import { fileSize } from '../lib/bytes'
import type { DesktopRelease, DesktopReleaseList, DesktopVersionPolicy } from '../../shared/types'
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
function VersionPolicyPanel({
  policy,
  onSaved,
}: {
  policy: DesktopVersionPolicy | null
  onSaved: () => Promise<void>
}) {
  const [draft, setDraft] = useState<DesktopVersionPolicy | null>(policy)
  const { message, busy, run } = useStatus()

  // The form follows the loaded policy, including after a save reloads it. It
  // is a draft rather than a view of it, so nothing else can put it back.
  useEffect(() => {
    setDraft(policy)
  }, [policy])

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
            if (ok) void onSaved()
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

/**
 * What is actually in R2, so the policy above can be checked against it.
 *
 * The two are decided in different places — one in the form above, one by a CI
 * job — so "最新版本 0.2.0" could name a build nobody ever uploaded, and until
 * this panel existed the only way to find out was the Cloudflare dashboard.
 *
 * Loaded by hand, and that is the design rather than an omission: listing a
 * bucket is billed, this page is opened rarely, and a panel that refreshed
 * itself would be a page spending money while nobody reads it. What is shown is
 * the record from the last time somebody asked — so it can be out of date, and
 * it says when it was taken instead of pretending otherwise.
 */
function ReleaseListPanel({
  policy,
  onError,
}: {
  policy: DesktopVersionPolicy | null
  onError: (error: unknown) => void
}) {
  const [list, setList] = useState<DesktopReleaseList | null>(null)
  const { message, busy, run } = useStatus()
  const { ask, dialog } = useConfirm()

  const load = useCallback(async () => {
    try {
      // The record, which costs nothing. The bucket is only read by the button.
      setList(await api<DesktopReleaseList>('/api/desktop/releases'))
    } catch (error) {
      onError(error)
    }
  }, [onError])

  useEffect(() => {
    void load()
  }, [load])

  /** Why this version may not be deleted, or nothing. */
  function refusalFor(version: string): string | null {
    if (policy === null) return null
    if (version === policy.latest) {
      return '這是版本政策指定的最新版本，刪掉之後每一台工具都會下載到 404'
    }
    if (version === policy.minSupported) {
      return '這是版本政策的最低支援版本，刪掉之後政策會指著一個不存在的版本'
    }
    return null
  }

  /**
   * The installer, not its blockmap — the blockmap is only of use to an updater
   * working out which parts of a download it can skip.
   *
   * Built on the feed the server reported, like the link in the panel above. A
   * host written here is a host that is wrong on whichever deployment is not
   * production, and the symptom is a copied link that 404s.
   */
  function downloadUrl(entry: DesktopRelease): string {
    const installer = entry.files.find((file) => file.endsWith('.exe'))
    return installer && policy ? `${policy.feedUrl}/${installer}` : ''
  }

  async function refresh() {
    // The one action here that reads R2, and the only one that costs anything.
    await run(async () => {
      setList(await apiJson<DesktopReleaseList>('/api/desktop/releases/refresh', 'POST', {}))
    }, '已重新讀取 R2 上的版本。')
  }

  async function remove(entry: DesktopRelease) {
    const confirmed = await ask({
      title: `刪除 ${entry.version}？`,
      body: (
        <p>
          R2 上這個版本的 {entry.files.length} 個檔案會直接刪掉。已經裝了這一版的人不受影響，
          但這一版以後裝不回來，也沒有辦法把 R2 上的物件補回去。
        </p>
      ),
      confirmLabel: '確定刪除',
    })
    if (!confirmed) return

    await run(async () => {
      await api(`/api/desktop/releases/${encodeURIComponent(entry.version)}`, { method: 'DELETE' })
    }, `${entry.version} 已刪除。`)
    // The record, not the bucket: the server removed those rows as it went.
    await load()
  }

  const columns: Column<DesktopRelease>[] = [
    {
      key: 'version',
      label: '版本',
      render: (row) => (
        <>
          {row.version}
          {row.version === policy?.latest ? <Badge tone="success">發佈中</Badge> : null}
          {row.version === policy?.minSupported ? <Badge tone="neutral">最低支援</Badge> : null}
        </>
      ),
    },
    { key: 'bytes', label: '大小', render: (row) => fileSize(row.bytes) },
    {
      key: 'files',
      label: '檔案',
      // The count, because it is what a delete removes: an installer whose
      // blockmap is missing is an update that downloads and cannot verify.
      render: (row) => `${row.files.length} 個`,
    },
    {
      key: 'uploadedAt',
      label: '上傳時間',
      render: (row) => (row.uploadedAt === null ? '—' : dateTime(row.uploadedAt)),
    },
    {
      key: 'actions',
      label: '',
      render: (row) => {
        const refusal = refusalFor(row.version)
        return (
          <>
            <CopyButton value={downloadUrl(row)} label={`複製 ${row.version} 的下載網址`} />
            <Menu label={`${row.version} 的操作`}>
              <MenuItem
                tone="danger"
                disabled={refusal !== null}
                // The reason, where somebody who wonders why will look for it.
                // The server refuses the same two versions — this is the half
                // that can be seen before clicking.
                title={refusal ?? undefined}
                onClick={() => void remove(row)}
              >
                刪除
              </MenuItem>
            </Menu>
          </>
        )
      },
    },
  ]

  return (
    <Panel title="R2 上的安裝檔">
      {dialog}
      <p class="muted">
        上面的版本政策是打上去的，這份清單是 R2 真的有的東西 —— 兩邊對不起來，就是有人指了一個沒上傳的版本。
        列一次 R2 要錢，所以要按下面的按鈕才會去問。
      </p>

      <Button tone="ghost" busy={busy} onClick={() => void refresh()}>
        重新載入 R2 清單
      </Button>

      {message ? <p class={message.kind === 'error' ? 'alert' : 'muted'}>{message.text}</p> : null}

      {list === null ? (
        <Spinner />
      ) : list.refreshedAt === null ? (
        // Not an empty list under a date: nobody has looked, and saying "沒有
        // 任何安裝檔" would be a claim about a bucket this page has not read.
        <p class="muted">尚未載入。按上面的按鈕才會去問 R2。</p>
      ) : (
        <>
          <p class="muted">{dateTime(list.refreshedAt)} 讀到的。刪除或上傳之後要重新載入才會更新。</p>
          {list.hasFeed ? null : (
            // The one thing in here that is broken rather than merely absent:
            // every installed tool goes on believing it is current, and every
            // version in the table below looks perfectly fine.
            <p class="alert">R2 上沒有 latest.yml，已安裝的工具不會知道有新版本。</p>
          )}
          <DataTable
            rows={list.versions}
            columns={columns}
            rowKey={(row) => row.version}
            empty={
              <EmptyState
                title="R2 上沒有安裝檔"
                body="版本政策指到的版本現在都不存在，任何工具去更新都會拿到 404。"
              />
            }
          />
        </>
      )}
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
  const [policy, setPolicy] = useState<DesktopVersionPolicy | null>(null)
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

  // Read once here rather than by each panel that needs it. The release list
  // disables a delete on the strength of `latest`, and a second copy of the
  // policy is a button and a rule that can disagree with each other.
  const loadPolicy = useCallback(async () => {
    try {
      setPolicy(await api<DesktopVersionPolicy>('/api/desktop/version-policy'))
    } catch (error) {
      showError(error)
    }
  }, [showError])

  useEffect(() => {
    void load()
    void loadPolicy()
    return () => {
      // Any answer still in flight belongs to a page that has gone.
      generation.current++
    }
  }, [load, loadPolicy])

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

      <VersionPolicyPanel policy={policy} onSaved={loadPolicy} />
      <ReleaseListPanel policy={policy} onError={showError} />
    </AdminShell>
  )
}
