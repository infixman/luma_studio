import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

import { AdminShell } from '../components/AdminShell'
import { useStatus } from '../components/StatusBar'
import {
  Badge,
  DataTable,
  EmptyState,
  MenuItem,
  Modal,
  Panel,
  Spinner,
  useConfirm,
} from '../components/ui'
import type { Column } from '../components/ui'
import { ApiError, api, apiJson, ownApiUrl } from '../../shared/api'
import { dateTime } from '../../shared/dates'
import { fileSize } from '../lib/bytes'
import {
  canAbort,
  canArchive,
  canPreview,
  runtime,
  videoFailure,
  videoStatusLabel,
  videoStatusTone,
} from '../lib/videoFacts'
import { HlsVideo } from '../../shared/components/HlsVideo'
import type { VideoAsset } from '../../shared/types'
import '../styles/shop-admin.css'

/** How often the list catches up with a transcode. */
const POLL_MS = 3_000

/**
 * How many failed polls before the page stops trying.
 *
 * Not one: a single dropped request on a laptop lid closing is not a reason to
 * stop refreshing. Not unlimited either — a poll that keeps failing every three
 * seconds is a page that never recovers and never says so.
 */
const MAX_POLL_FAILURES = 3

/**
 * What has been uploaded.
 *
 * Until this screen existed the uploads were invisible from here: the desktop
 * tool said "ready" and the back office had no way to confirm it, see what a
 * bucket was holding, or retire anything. The course editor could pick a video,
 * which meant the only list of videos was a dropdown inside another job.
 *
 * It polls rather than offering a refresh button, because the interesting states
 * are the ones that change on their own — an upload lands, a transcode finishes —
 * and a screen you have to reload to believe is a screen nobody believes. It
 * stops while the tab is in the background: this is a page people leave open all
 * day, and nobody is reading it then.
 *
 * A failing poll is deliberately quiet. It has no user behind it, so reporting
 * it in the status bar would overwrite whatever the admin's own last action
 * said — including the confirmation of an archive that worked — every three
 * seconds. Instead it gives up after a few tries and says so in the panel,
 * where it stays put.
 *
 * The thumbnails come through the Worker rather than from a signed URL. A URL for
 * a private object is a capability that outlives the page it was put on, and a
 * thumbnail is not worth minting one for.
 *
 * Playing one is the same gateway members use, with a token this page asks for.
 * Not a second way into the bucket: the token names one asset and one encode
 * version, expires, and is the only way past the gateway either way. What is new
 * is who may be issued one — and the reason to allow it is that nothing else can
 * tell you a transcode came out right. Every object exists and the manifest
 * parses whether or not the picture is a mess.
 */
export function VideoLibraryPage() {
  const [assets, setAssets] = useState<VideoAsset[] | null>(null)
  const [watching, setWatching] = useState<{ asset: VideoAsset; url: string } | null>(null)
  const [playerFailed, setPlayerFailed] = useState(false)
  const [missingPosters, setMissingPosters] = useState<Set<string>>(new Set())
  const [stalled, setStalled] = useState(false)
  const { message, showError, run } = useStatus()
  const { ask, dialog } = useConfirm()

  // Which load the displayed list belongs to. A poll answering after a newer
  // one, or after the page has gone, must not set state — two requests are in
  // flight whenever a poll overlaps the reload that follows an archive, and the
  // slower one is not always the older one.
  const generation = useRef(0)
  const failures = useRef(0)

  const load = useCallback(
    async ({ background = false }: { background?: boolean } = {}) => {
      const mine = ++generation.current
      try {
        const listing = await api<{ assets: VideoAsset[] }>('/api/video-assets')
        if (mine !== generation.current) return
        setAssets(listing.assets)
        failures.current = 0
        setStalled(false)
      } catch (error) {
        if (mine !== generation.current) return
        if (!background) {
          showError(error)
          return
        }
        // A dead session is not worth three more tries: the api client has
        // already sent the visitor to sign in again, and every further poll is
        // a request against nothing.
        const gone = error instanceof ApiError && error.status === 401
        failures.current += 1
        if (gone || failures.current >= MAX_POLL_FAILURES) setStalled(true)
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

  useEffect(() => {
    if (stalled) return

    let timer: ReturnType<typeof setInterval> | null = null

    const stop = () => {
      if (timer !== null) clearInterval(timer)
      timer = null
    }

    const start = () => {
      if (timer === null) timer = setInterval(() => void load({ background: true }), POLL_MS)
    }

    const onVisibility = () => {
      if (document.hidden) {
        stop()
        return
      }
      // A tab coming back to the front is stale by however long it was away, so
      // it asks straight away rather than at the end of the next interval.
      void load({ background: true })
      start()
    }

    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [load, stalled])

  /**
   * The two ways out of use, which differ only in words.
   *
   * Archiving is for a video that was something; abandoning is for an upload that
   * never became one. Same guard on the server, same shape here — one function so
   * the confirmation and the reload cannot drift apart between them.
   */
  async function retire(asset: VideoAsset, kind: 'archive' | 'abort') {
    const words =
      kind === 'archive'
        ? {
            title: '封存這支影片？',
            body: (
              <p>
                「{asset.title}」會從可選清單中移除。已經在使用它的課程單元會擋下這個動作，
                所以封存不會讓任何會員看不到影片。
              </p>
            ),
            confirmLabel: '確定封存',
            done: '影片已封存。',
          }
        : {
            // Both sentences are checked against what the server actually does.
            // Registering refuses a retired asset, so "will not become playable"
            // is true even if the tool finishes and calls import. The leftover
            // objects are real and there is no cleanup tool yet, so this says
            // they stay rather than promising something will collect them.
            title: '放棄這次上傳？',
            body: (
              <p>
                「{asset.title}」的上傳沒有完成，放棄之後它不會再變成可播放的影片，
                工具傳完也一樣。已經傳上去的檔案會留在儲存空間裡，要另外清掉。
              </p>
            ),
            confirmLabel: '確定放棄',
            done: '已放棄這次上傳。',
          }

    if (!(await ask(words))) return

    // Nothing is returned from the work: `run` treats whatever it hands back as
    // a sentence to show instead of the success message, and `apiJson` answers
    // with the asset — which renders as an empty status bar.
    //
    // The refusal is the interesting answer: the server names the lesson still
    // using the video, and `run` shows exactly that sentence.
    await run(async () => {
      await apiJson(`/api/video-assets/${encodeURIComponent(asset.id)}/${kind}`, 'POST', {})
    }, words.done)
    await load()
  }

  async function preview(asset: VideoAsset) {
    // The cookie comes back on this response and is scoped to the objects it
    // opens, so the player needs nothing but the URL.
    await run(async () => {
      const session = await apiJson<{ playbackUrl: string }>(
        `/api/video-assets/${encodeURIComponent(asset.id)}/playback-preview`,
        'POST',
        {},
      )
      setPlayerFailed(false)
      setWatching({ asset, url: session.playbackUrl })
    }, '已取得播放權限。')
  }

  const columns: Column<VideoAsset>[] = [
    {
      key: 'poster',
      label: '',
      render: (asset) =>
        asset.hasPoster && !missingPosters.has(asset.id) ? (
          <img
            class="video-thumb"
            // The version is in the URL so the answer can be cached for a year:
            // a re-encode is a new version, and without it a year-old thumbnail
            // would outlive the video it describes.
            src={ownApiUrl(
              `/api/video-assets/${encodeURIComponent(asset.id)}/poster?v=${asset.encodeVersion}`,
            )}
            alt=""
            loading="lazy"
            // The row's claim can outlive the object: a re-import without a
            // poster keeps the old flag. Falling back to the empty box beats the
            // browser's broken-image icon, which reads as a page that is failing.
            onError={() => setMissingPosters((known) => new Set(known).add(asset.id))}
          />
        ) : (
          // A grey box rather than nothing: the column stays the same width, and
          // "no thumbnail" is a fact about the encode worth seeing at a glance.
          <span class="video-thumb video-thumb-empty" aria-hidden="true" />
        ),
    },
    {
      key: 'title',
      label: '影片',
      render: (asset) => (
        <>
          <div>{asset.title || '未命名'}</div>
          {asset.originalFilename ? <div class="muted">{asset.originalFilename}</div> : null}
        </>
      ),
    },
    {
      key: 'status',
      label: '狀態',
      render: (asset) => {
        const failure = videoFailure(asset)
        return (
          <>
            <Badge tone={videoStatusTone(asset.status)}>{videoStatusLabel(asset.status)}</Badge>
            {failure ? <div class="muted">{failure}</div> : null}
          </>
        )
      },
    },
    // The dashes are a real state rather than a rendering gap: an upload that
    // never finished was never probed, so it has no length to report.
    { key: 'runtime', label: '長度', render: (asset) => runtime(asset.durationSeconds) || '—' },
    {
      key: 'size',
      label: '原始檔容量',
      render: (asset) => (asset.byteSize > 0 ? fileSize(asset.byteSize) : '—'),
    },
    {
      key: 'version',
      label: '轉檔版本',
      render: (asset) => (asset.encodeVersion === null ? '—' : `v${asset.encodeVersion}`),
    },
    { key: 'createdAt', label: '建立時間', render: (asset) => dateTime(asset.createdAt) },
  ]

  return (
    <AdminShell current="/videos" message={message} onError={showError}>
      {dialog}

      <Panel title="所有影片">
        <p class="muted">
          影片由桌面上傳工具轉檔並上傳，這裡看得到結果。列表每三秒自動更新，所以轉檔中的影片會自己變成可播放。
        </p>

        {stalled ? (
          <p class="muted">自動更新已停止 —— 伺服器連續沒有回應。重新整理這一頁再試。</p>
        ) : null}

        {assets === null ? (
          <Spinner />
        ) : (
          <DataTable
            rows={assets}
            columns={columns}
            rowKey={(asset) => asset.id}
            menu={(asset) => (
              <>
                {canPreview(asset) ? (
                  <MenuItem onClick={() => void preview(asset)}>預覽播放</MenuItem>
                ) : null}
                {canArchive(asset) ? (
                  <MenuItem tone="danger" onClick={() => void retire(asset, 'archive')}>
                    封存
                  </MenuItem>
                ) : null}
                {canAbort(asset) ? (
                  <MenuItem tone="danger" onClick={() => void retire(asset, 'abort')}>
                    放棄上傳
                  </MenuItem>
                ) : null}
              </>
            )}
            empty={
              <EmptyState
                title="還沒有影片"
                body="用桌面上傳工具把課程影片轉檔並上傳，完成後會出現在這裡。"
              />
            }
          />
        )}
      </Panel>

      <Modal
        title={watching ? `預覽：${watching.asset.title || '未命名'}` : ''}
        open={watching !== null}
        onClose={() => setWatching(null)}
        width="lg"
      >
        {watching ? (
          <>
            <HlsVideo
              src={ownApiUrl(watching.url)}
              class="video-preview"
              // Otherwise a failure is a black rectangle: hls.js gives up
              // quietly, and the status bar has already said the permission was
              // granted — which it was. What failed is the playing.
              onError={() => setPlayerFailed(true)}
            />
            {playerFailed ? (
              <p class="muted">播放失敗。通行證會過期，關掉再開一次就會重新取得。</p>
            ) : null}
            <p class="muted">
              這是轉檔品質的驗收，不是會員入口 —— 這張通行證只開這一支影片的這一版，而且很快就失效。
            </p>
          </>
        ) : null}
      </Modal>
    </AdminShell>
  )
}
