/**
 * Whether this build is still allowed to work.
 *
 * The server decides — see `backend/src/domain/desktop_release.py`. The tool
 * asks with its own version and is given a verdict rather than a policy to
 * interpret, because two implementations of "am I too old" eventually disagree
 * and the one that is wrong is the one still uploading.
 *
 * Failing to reach the server does not stop anything, and that is not
 * generosity: every upload goes through the same API, so a tool that cannot ask
 * cannot upload either. Blocking here would turn a moment of bad wifi into a
 * screen saying the tool is out of date, which is a different and wrong thing to
 * tell somebody.
 */

export interface VersionVerdict {
  allowed: boolean
  mustUpdate: boolean
  updateAvailable: boolean
  reason: string
}

export interface VersionState {
  /** Null while the answer has not arrived, or when it could not be asked. */
  verdict: VersionVerdict | null
  latest: string
  notes: string
}

const REASONS: Record<string, string> = {
  blocked: '這個版本已被停用，請安裝新版之後再繼續。',
  tooOld: '這個版本太舊，已經不能上傳影片了。請安裝新版。',
  forced: '有一個必要的更新，請安裝新版之後再繼續。',
  unreadableVersion: '無法辨識這個安裝版本，請重新安裝。',
}

/** Whether work may start. Unknown means yes — see the note at the top. */
export function mayWork(state: VersionState | null): boolean {
  return state?.verdict ? state.verdict.allowed : true
}

/**
 * What to tell somebody, or nothing.
 *
 * A version that merely has an update available is told once and not stopped:
 * the difference between "there is a new one" and "you cannot work" is the whole
 * point of having two levers, and blurring it teaches people to ignore both.
 */
export function versionMessage(state: VersionState | null): string {
  const verdict = state?.verdict
  if (!verdict) return ''
  if (!verdict.allowed) {
    const said = REASONS[verdict.reason] ?? '這個版本目前不能使用，請安裝新版。'
    return state && state.latest ? `${said}（最新版本 ${state.latest}）` : said
  }
  if (verdict.updateAvailable) {
    return state && state.latest ? `有新版本 ${state.latest} 可以更新。` : '有新版本可以更新。'
  }
  return ''
}
