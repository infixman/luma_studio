import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

import { AdminShell } from '../components/AdminShell'
import { useStatus } from '../components/StatusBar'
import { Badge, Button, DataTable, EmptyState, Panel, Spinner, useConfirm } from '../components/ui'
import type { Column } from '../components/ui'
import { api, apiJson } from '../../shared/api'
import { dateTime } from '../../shared/dates'
import { fileSize } from '../lib/bytes'
import { canAbort, videoStatusLabel, videoStatusTone } from '../lib/videoFacts'
import type {
  CleanupCandidates,
  StorageOrphan,
  StorageSource,
  StorageSummary,
  StorageVersion,
} from '../../shared/types'
import '../styles/shop-admin.css'

type Tab = 'overview' | 'sources' | 'outputs'

/**
 * The three ways something can be removed on judgement, and what each costs.
 *
 * Declared beside the page rather than with the other API shapes, because it is
 * the page that owes each kind a sentence: a kind the server can produce and
 * this file has no wording for is a delete button that says nothing, and a type
 * that lives where the branch lives cannot be widened without noticing.
 */
export type RemovalKind = 'unusedSource' | 'unfinishedUpload' | 'entireVideo'

export interface Removal {
  kind: RemovalKind
  assetId: string
  title: string
  bytes: number
  consequence: string
}

export type StorageCandidates = Omit<CleanupCandidates, 'needsJudgement'> & {
  needsJudgement: Removal[]
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: '總覽' },
  { id: 'sources', label: '原始檔' },
  { id: 'outputs', label: '輸出與孤兒' },
]

/**
 * What one entry offers to remove, in words somebody can refuse.
 *
 * One table rather than a dialog per button, so the three sentences sit beside
 * each other: they are easy to write and hard to tell apart at four in the
 * afternoon, and the whole value of the confirmation is that it names which of
 * the three this one is.
 */
/** What names one running action. Two removals differ by asset, not only kind. */
function busyKey(entry: Removal): string {
  return `${entry.kind}:${entry.assetId}`
}

function removalCopy(entry: Removal): {
  summary: string
  label: string
  title: string
  body: preact.JSX.Element
  confirmLabel: string
  done: string
} {
  switch (entry.kind) {
    case 'unfinishedUpload':
      return {
        summary: `「${entry.title}」沒有上傳完成`,
        label: '刪除這筆上傳',
        title: `刪除「${entry.title}」這筆沒完成的上傳？`,
        body: (
          <p>
            {entry.consequence}。這一筆還不是能播的影片，刪掉之後它會從影片庫消失，已經送出的分段也不再算錢。
          </p>
        ),
        confirmLabel: '確定刪除這筆上傳',
        done: '這筆上傳已刪除。',
      }
    case 'entireVideo':
      return {
        summary: `「${entry.title}」整支影片`,
        label: '刪除整支影片',
        title: `刪除整支「${entry.title}」？`,
        body: (
          <p>
            {entry.consequence}。原始檔、每一個畫質版本和這一列都會不見。現在沒有任何單元用它 ——
            刪掉之後也沒有辦法再拿回來。
          </p>
        ),
        confirmLabel: '確定刪除整支影片',
        done: '影片已刪除。',
      }
    // No `default`. A kind added to the union and not to this switch is a type
    // error here, which is the only place that noticing it costs nothing.
    case 'unusedSource':
      return {
        summary: `「${entry.title}」的原始檔`,
        label: '刪除這一支',
        title: `刪除「${entry.title}」的原始檔？`,
        body: (
          <p>
            {entry.consequence}。已經轉好的畫質階梯還在，會員照樣看得到 —— 但這支影片以後不能再加畫質、
            不能修，也補不回 R2 掉掉的物件。
          </p>
        ),
        confirmLabel: '確定刪除原始檔',
        done: '原始檔已刪除。',
      }
  }
}

/**
 * Where the storage bill becomes somebody's problem.
 *
 * The capacity and the money are first because they are the only reason anybody
 * opens this page: nothing else about a course library reminds you that last
 * year's re-encodes are still there. Everything below them exists to make the
 * number smaller, in an order that matches how dangerous it is — the rubbish in
 * one action, the decisions one at a time.
 *
 * The page decides nothing about safety. The server splits the candidates,
 * because a screen that sorted them itself would be a second opinion about which
 * deletions are irreversible.
 */
export function StoragePage() {
  const [tab, setTab] = useState<Tab>('overview')
  // Which action is running, not merely that one is. `busy` from useStatus is
  // one flag for the page, so binding every button to it made pressing one
  // removal spin the sweep, the bulk clear and every other removal — four
  // things claiming to be happening, one of which is.
  const [running, setRunning] = useState<string | null>(null)
  const [summary, setSummary] = useState<StorageSummary | null>(null)
  const [candidates, setCandidates] = useState<StorageCandidates | null>(null)
  const [sources, setSources] = useState<StorageSource[] | null>(null)
  const [orphans, setOrphans] = useState<StorageOrphan[] | null>(null)
  const [openAsset, setOpenAsset] = useState<string | null>(null)
  const [versions, setVersions] = useState<StorageVersion[] | null>(null)
  const { message, showError, busy, run } = useStatus()
  const { ask, dialog } = useConfirm()

  // A load answering after the page has gone, or after a newer one, must not
  // set state — the same guard the video library uses, for the same reason.
  const generation = useRef(0)

  const load = useCallback(async () => {
    const mine = ++generation.current
    // Settled rather than all: one endpoint failing must not blank the other
    // three. A page stuck on a spinner because the orphan list is unavailable
    // hides the capacity figures, which are the reason somebody came.
    const answers = await Promise.allSettled([
      api<StorageSummary>('/api/video-storage/summary'),
      api<StorageCandidates>('/api/video-storage/cleanup-candidates'),
      api<{ sources: StorageSource[] }>('/api/video-storage/sources'),
      api<{ objects: StorageOrphan[] }>('/api/video-storage/orphans?bucket=output'),
    ])
    if (mine !== generation.current) return

    const [overview, cleanup, sourceList, orphanList] = answers
    if (overview.status === 'fulfilled') setSummary(overview.value)
    if (cleanup.status === 'fulfilled') setCandidates(cleanup.value)
    if (sourceList.status === 'fulfilled') setSources(sourceList.value.sources)
    if (orphanList.status === 'fulfilled') setOrphans(orphanList.value.objects)

    const failed = answers.find((answer) => answer.status === 'rejected')
    if (failed && failed.status === 'rejected') showError(failed.reason)
  }, [showError])

  const openVersions = useCallback(
    async (assetId: string) => {
      setOpenAsset(assetId)
      setVersions(null)
      try {
        const answer = await api<{ versions: StorageVersion[] }>(
          `/api/video-storage/versions?assetId=${encodeURIComponent(assetId)}`,
        )
        setVersions(answer.versions)
      } catch (error) {
        showError(error)
      }
    },
    [showError],
  )

  useEffect(() => {
    void load()
    return () => {
      generation.current++
    }
  }, [load])

  async function sweep() {
    // The one action that reads the buckets, so it says so before it runs.
    await run(async () => {
      await apiJson('/api/video-storage/scan', 'POST', {})
    }, '盤點完成。')
    await load()
  }

  async function clearSafe() {
    if (!candidates?.safe.length) return
    const confirmed = await ask({
      title: '清掉這些安全項目？',
      body: (
        <p>
          這些是孤兒物件與已被取代的舊版本，刪掉不會失去任何還在用的東西。共 {candidates.safe.length} 項。
        </p>
      ),
      confirmLabel: '確定清除',
    })
    if (!confirmed) return

    const entries = candidates.safe
    await run(async () => {
      // One request per entry, and one refusal does not stop the rest. The
      // server can decline any of these on its own grounds — a version that
      // became live, a source a lesson started using — and stopping at the
      // first would leave some deletions done, some skipped, and no way to tell
      // which.
      let cleared = 0
      const refused: string[] = []
      for (const entry of entries) {
        try {
          await apiJson('/api/video-storage/cleanup', 'POST', entry)
          cleared += 1
        } catch (error) {
          refused.push(error instanceof Error ? error.message : '未知的錯誤')
        }
      }
      // Returned rather than thrown: some of it worked, and `run` shows a
      // returned sentence in the warning tone, which is what this is.
      return refused.length
        ? `清除了 ${cleared} 項，${refused.length} 項被拒絕：${refused[0]}`
        : undefined
    }, '已清除。')
    await load()
  }

  async function remove(entry: Removal) {
    setRunning(busyKey(entry))
    // Named, and with the consequence in the dialog. No select-all exists for
    // this list: every one of these is a different video and a different loss.
    const copy = removalCopy(entry)
    const confirmed = await ask({
      title: copy.title,
      body: copy.body,
      confirmLabel: copy.confirmLabel,
    })
    if (!confirmed) return

    try {
      await run(async () => {
        await apiJson('/api/video-storage/cleanup', 'POST', { kind: entry.kind, assetId: entry.assetId })
      }, copy.done)
      await load()
    } finally {
      setRunning(null)
    }
  }

  /** What this row may be offered, in the server's own order of preference.
   *
   * A copy of the rule `cleanup.candidates` applies, for the same reason
   * `canArchive` copies the state table: it decides what to offer, never what
   * is allowed. The server refuses all three again.
   */
  function removalsFor(row: StorageSource): Removal[] {
    // In use by a lesson: no entry of any kind. Not a warning and not a
    // disabled button — nothing to consider.
    if (row.lessons.length > 0) return []
    if (canAbort(row)) {
      return [
        {
          kind: 'unfinishedUpload',
          assetId: row.assetId,
          title: row.title,
          bytes: row.bytes,
          consequence: '已經送到 R2 的分段會一起刪掉',
        },
      ]
    }
    // Mid-transcode: a container may still be writing its objects, so it has to
    // finish or fail before anybody decides anything.
    if (row.status === 'processing') return []
    return [
      {
        kind: 'entireVideo',
        assetId: row.assetId,
        title: row.title,
        bytes: row.bytes + row.versionBytes,
        consequence: '整支影片、所有畫質版本與這筆紀錄都會刪除，無法復原',
      },
    ]
  }

  const sourceColumns: Column<StorageSource>[] = [
    { key: 'title', label: '影片', render: (row) => row.title || '未命名' },
    {
      key: 'status',
      label: '狀態',
      render: (row) => <Badge tone={videoStatusTone(row.status)}>{videoStatusLabel(row.status)}</Badge>,
    },
    { key: 'bytes', label: '原始檔', render: (row) => (row.bytes > 0 ? fileSize(row.bytes) : '—') },
    {
      key: 'versions',
      label: '輸出',
      // "No playable version" is not "old": it means the upload never finished,
      // which points the other way about deleting it.
      render: (row) =>
        row.hasPlayableVersion ? (
          `${row.versionCount} 版 / ${fileSize(row.versionBytes)}`
        ) : (
          <span class="muted">尚無可播放版本</span>
        ),
    },
    {
      key: 'lessons',
      label: '使用中的單元',
      // Links rather than a count. The decision is not "3 lessons", it is
      // "that course closed last year" — which needs the course's name and a
      // way to go and look.
      render: (row) =>
        row.lessons.length === 0 ? (
          <span class="muted">沒有課程使用</span>
        ) : (
          <>
            {row.lessons.map((lesson) => (
              <div key={lesson.lessonId}>
                <a href={`/courses/${encodeURIComponent(lesson.courseId)}`}>
                  {lesson.courseTitle}／{lesson.lessonTitle}
                </a>
              </div>
            ))}
          </>
        ),
    },
    { key: 'createdAt', label: '上傳時間', render: (row) => dateTime(row.createdAt) },
    {
      key: 'remove',
      label: '',
      // Beside the row rather than only under 總覽. Somebody looking for the
      // video they want gone looks at the list of videos, and finding nothing
      // there reads as "this cannot be deleted".
      render: (row) => (
        <>
          {removalsFor(row).map((entry) => (
            <Button
              key={entry.kind}
              tone="ghost"
              size="sm"
              busy={running === busyKey(entry)}
              disabled={busy && running !== busyKey(entry)}
              onClick={() => void remove(entry)}
            >
              {removalCopy(entry).label}
            </Button>
          ))}
        </>
      ),
    },
  ]

  return (
    <AdminShell current="/storage" message={message} onError={showError}>
      {dialog}

      <Panel title="空間用量">
        <nav class="ui-tabs" role="tablist" aria-label="影片儲存空間">
          {TABS.map((entry) => (
            <Button
              key={entry.id}
              role="tab"
              aria-selected={entry.id === tab}
              tone={entry.id === tab ? 'primary' : 'ghost'}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </Button>
          ))}
        </nav>

        {summary === null ? <Spinner /> : null}

        {summary && tab === 'overview' && (
          <>
            <dl class="storage-figures">
              <dt>原始檔</dt>
              <dd>{fileSize(summary.source.bytes)}（{summary.source.objects} 支）</dd>
              <dt>轉檔輸出</dt>
              <dd>{fileSize(summary.output.bytes)}（{summary.output.objects} 個物件）</dd>
              <dt>每月費用</dt>
              <dd>
                {summary.estimate === null ? (
                  // Not a made-up number. R2's prices change, and a stale one
                  // reads exactly like an accurate one.
                  <span class="muted">尚未設定單價，無法估算</span>
                ) : (
                  <>
                    約 US${summary.estimate.monthlyUsd.toFixed(2)}
                    <span class="muted">
                      （估算，每 GB US${summary.estimate.pricePerGbMonthUsd}、免費額度{' '}
                      {summary.estimate.freeGb} GB，不含操作費用）
                    </span>
                  </>
                )}
              </dd>
              <dt>本月增加</dt>
              <dd>{fileSize(summary.growth.bytesThisMonth)}</dd>
              <dt>孤兒</dt>
              <dd>
                {summary.orphans === null ? (
                  // "Never swept" and "none found" are different facts, and only
                  // one of them is a reason to stop looking.
                  <span class="muted">尚未盤點</span>
                ) : (
                  <>
                    原始檔 {fileSize(summary.orphans.sourceBytes)}、輸出{' '}
                    {fileSize(summary.orphans.outputBytes)}
                    <span class="muted">（{dateTime(summary.orphans.scannedAt)} 盤點）</span>
                    {summary.orphans.truncated ? (
                      <span class="muted">這次沒有掃完，再跑一次會接著找</span>
                    ) : null}
                  </>
                )}
              </dd>
            </dl>

            <Button
              tone="ghost"
              busy={running === 'sweep'}
              disabled={busy && running !== 'sweep'}
              onClick={() => void sweep()}
            >
              重新盤點
            </Button>

            <h3>可以直接清除</h3>
            {candidates?.safe.length ? (
              <>
                <ul>
                  {candidates.safe.map((entry) => (
                    <li key={entry.kind === 'orphan' ? `orphan-${entry.bucket}` : `v-${entry.assetId}-${entry.encodeVersion}`}>
                      {entry.kind === 'orphan'
                        ? `${entry.bucket === 'source' ? '原始檔' : '輸出'}桶的孤兒物件 ${entry.keys} 個`
                        : `「${entry.title}」的舊版本 v${entry.encodeVersion}`}
                      ：{fileSize(entry.bytes)}
                    </li>
                  ))}
                </ul>
                <Button
                  tone="danger"
                  busy={running === 'clear'}
                  disabled={busy && running !== 'clear'}
                  onClick={() => void clearSafe()}
                >
                  全部清除
                </Button>
              </>
            ) : (
              <p class="muted">沒有可以直接清除的東西。</p>
            )}

            <h3>要判斷的</h3>
            {candidates?.needsJudgement.length ? (
              <ul>
                {candidates.needsJudgement.map((entry) => {
                  const copy = removalCopy(entry)
                  return (
                    // Keyed by kind as well as asset: one video can be offered
                    // both ways, and they are different decisions.
                    <li key={`${entry.kind}-${entry.assetId}`}>
                      {copy.summary}
                      {/* No "0 B". These rows are exactly the ones whose objects
                          are already gone, and a size is not why they go. */}
                      {entry.bytes > 0 ? ` ${fileSize(entry.bytes)}` : ''} —— {entry.consequence}
                      <Button
                        tone="ghost"
                        busy={running === busyKey(entry)}
                        disabled={busy && running !== busyKey(entry)}
                        onClick={() => void remove(entry)}
                      >
                        {copy.label}
                      </Button>
                    </li>
                  )
                })}
              </ul>
            ) : (
              <p class="muted">沒有需要判斷的項目。</p>
            )}
          </>
        )}

        {summary && tab === 'sources' && (
          <DataTable
            rows={sources ?? []}
            columns={sourceColumns}
            rowKey={(row) => row.assetId}
            empty={<EmptyState title="還沒有原始檔" body="用桌面上傳工具上傳影片，原始檔會一起存進來。" />}
          />
        )}

        {summary && tab === 'outputs' && (
          <>
            <h3>轉檔版本</h3>
            <p class="muted">選一支影片，看它有哪些版本、哪一個是會員正在看的。</p>
            <ul class="storage-versions">
              {(sources ?? []).map((row) => (
                <li key={row.assetId}>
                  <Button tone="ghost" onClick={() => void openVersions(row.assetId)}>
                    {row.title || '未命名'}
                  </Button>
                  {openAsset === row.assetId && versions !== null ? (
                    <ul>
                      {versions.map((version) => (
                        <li key={version.encodeVersion}>
                          v{version.encodeVersion}：{version.objectCount} 個物件、
                          {fileSize(version.bytes)}
                          {version.isActive ? <Badge tone="success">播放中</Badge> : null}
                          {version.isSuperseded ? <Badge tone="neutral">已被取代</Badge> : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>

            <h3>孤兒物件</h3>
            <p class="muted">
              孤兒是 R2 裡有、但沒有任何一列記錄的物件。這份清單來自上一次盤點，不是即時的。
            </p>
            {orphans?.length ? (
              <ul>
                {orphans.slice(0, 50).map((object) => (
                  <li key={object.key}>
                    <code>{object.key}</code>（{fileSize(object.size)}）
                  </li>
                ))}
              </ul>
            ) : (
              <p class="muted">上一次盤點沒有找到輸出桶的孤兒。</p>
            )}
          </>
        )}
      </Panel>
    </AdminShell>
  )
}
