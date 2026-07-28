import { Badge, Button, ButtonRow, EmptyState, Panel } from './ui'
import { dateTime } from '../../shared/dates'
import type { PageVersion, PublishState } from '../../shared/types'

/**
 * Where this page stands, and the two buttons that change it.
 *
 * Status used to be a radio group — 草稿 / 公開 — which described a page as
 * having two states when it has three. The missing one is the one that
 * matters: edited since it was last published, and nothing on screen saying
 * so. That page looks finished and is not live.
 *
 * So the radio group is gone. Publishing is an action, not a field you set
 * and then remember to save, and the history below it is the record of that
 * action having been taken.
 */

const STATE: Record<PublishState, { label: string; tone: 'neutral' | 'success' | 'warning'; body: string }> = {
  draft: {
    label: '草稿',
    tone: 'neutral',
    body: '還沒有發布過，只有你看得到。',
  },
  published: {
    label: '已發布',
    tone: 'success',
    body: '網站上就是這一份內容。',
  },
  modified: {
    label: '有未發布的修改',
    tone: 'warning',
    body: '你改過的東西還沒上線。顧客現在看到的是上一個發布版。',
  },
}

export function PublishPanel({
  state,
  versions,
  busy,
  unsaved,
  hasBlocks,
  onPublish,
  onUnpublish,
  onRestore,
}: {
  state: PublishState
  versions: PageVersion[]
  busy: boolean
  /** Unsaved edits: publishing them would publish what is on the server, not what is on screen. */
  unsaved: boolean
  hasBlocks: boolean
  onPublish: () => void
  onUnpublish: () => void
  onRestore: (version: PageVersion) => void
}) {
  const meaning = STATE[state]
  // History past the current one. The current version is already described by
  // the badge above, and listing it again as something to restore invites the
  // question of what restoring what you already have would do.
  const past = versions.filter((version) => !version.isCurrent)

  return (
    <Panel title="發布" actions={<Badge tone={meaning.tone}>{meaning.label}</Badge>}>
      <p class="muted publish-note">{meaning.body}</p>

      <ButtonRow>
        {/* Not rendered when there is nothing to publish. A greyed-out
            button reading 發布這些修改 still claims there are modifications,
            and the badge above has just said there are none. */}
        {state !== 'published' && (
          <Button
            tone="primary"
            busy={busy}
            // Publishing reads the server, so unsaved edits would go live as
            // whatever was last saved — which is not what the person pressing
            // the button is looking at.
            disabled={unsaved || !hasBlocks}
            onClick={onPublish}
          >
            {state === 'draft' ? '發布' : '發布這些修改'}
          </Button>
        )}
        {state !== 'draft' && (
          <Button tone="ghost" busy={busy} onClick={onUnpublish}>
            取消發布
          </Button>
        )}
      </ButtonRow>

      {unsaved && <p class="muted publish-note">先儲存才能發布——發布送出的是伺服器上的內容。</p>}
      {!hasBlocks && <p class="muted publish-note">這一頁還沒有任何區塊。</p>}

      <h3 class="publish-history-title">發布紀錄</h3>
      {past.length === 0 ? (
        <EmptyState
          title={versions.length === 0 ? '還沒有發布過' : '只有目前這一版'}
          body="每次發布都會留下一份，最多 20 份。"
          compact
        />
      ) : (
        <ul class="publish-history">
          {past.map((version) => (
            <li key={version.id}>
              <div>
                <time dateTime={new Date(version.publishedAt * 1000).toISOString()}>
                  {dateTime(version.publishedAt)}
                </time>
                {version.publishedBy && <span class="muted">{version.publishedBy}</span>}
              </div>
              <Button size="sm" tone="ghost" disabled={busy} onClick={() => onRestore(version)}>
                還原
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}
