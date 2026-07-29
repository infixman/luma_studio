import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

import { CopyButton, OpenButton } from '../components/IconButtons'
import { Lightbox } from '../components/Lightbox'
import { AdminShell } from '../components/AdminShell'
import { useStatus } from '../components/StatusBar'
import { EmptyState, Spinner, useConfirm } from '../components/ui'
import { fileSize } from '../lib/mediaFacts'
import { api, apiJson, printPageUrl, publicImageUrl, thumbnailUrl, uploadImage } from '../../shared/api'
import {
  applyChoice,
  defaultPrintChoice,
  fromSelectType,
  isOptionDisabled,
  settingGroups,
  toSelectType,
  type PrintChoice,
} from '../lib/printSpec'
import type { FolderListing, ObjectListing, PrintSettingsResponse, StoredObject } from '../../shared/types'
import '../styles/admin.css'

const MAX_FILE_COUNT = 8
const MAX_TOTAL_BYTES = 15 * 1024 * 1024
const IMAGE_PATTERN = /\.(jpg|jpeg|png|bmp|gif)$/i

interface UploadProgress {
  label: string
  ratio: number
}

export function AdminPage() {
  const { message, show, showError } = useStatus()
  const { ask, dialog } = useConfirm()
  const [ready, setReady] = useState(false)
  const [folders, setFolders] = useState<string[]>([])
  const [folder, setFolder] = useState<string | null>(null)
  const [files, setFiles] = useState<StoredObject[]>([])
  const [choice, setChoice] = useState<PrintChoice>({ ...defaultPrintChoice })
  const [summary, setSummary] = useState('')
  const [newFolder, setNewFolder] = useState('')
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState<UploadProgress | null>(null)
  const [dragging, setDragging] = useState(false)
  const [lightbox, setLightbox] = useState<{ src: string; alt: string } | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const remaining = Math.max(0, MAX_FILE_COUNT - files.length)
  const full = folder !== null && remaining === 0
  const uploadDisabled = folder === null || uploading || full

  const loadFolders = useCallback(async () => {
    const data = await api<FolderListing>('/api/folders')
    setFolders(data.folders)
  }, [])

  const loadFiles = useCallback(async (target: string) => {
    const data = await api<ObjectListing>(`/api/objects?folder=${encodeURIComponent(target)}`)
    setFiles(data.objects)
  }, [])

  // Folder loads race each other when the operator clicks quickly. Only the
  // newest selection may write to state, otherwise a later action would target
  // the folder in the heading while carrying the previous folder's data.
  const selectionToken = useRef(0)

  const selectFolder = useCallback(
    async (target: string) => {
      selectionToken.current += 1
      const token = selectionToken.current
      setFolder(target)
      setFiles([])
      try {
        const [listing, settings] = await Promise.all([
          api<ObjectListing>(`/api/objects?folder=${encodeURIComponent(target)}`),
          api<PrintSettingsResponse>(`/api/print-settings?folder=${encodeURIComponent(target)}`),
        ])
        if (token !== selectionToken.current) return
        setFiles(listing.objects)
        setChoice(fromSelectType(settings.selectType))
        setSummary(`目前規格：${settings.printSpec}（${settings.selectType}）`)
      } catch (error) {
        if (token === selectionToken.current) showError(error)
      }
    },
    [showError],
  )

  useEffect(() => {
    let cancelled = false
    const start = async () => {
      try {
        await api<{ email: string }>('/api/session')
        if (cancelled) return
        setReady(true)
        await loadFolders()
      } catch (error) {
        // A 401 has already redirected to Google inside the API wrapper.
        if (!cancelled) showError(error)
      }
    }
    void start()
    return () => {
      cancelled = true
    }
  }, [loadFolders, showError])

  const createFolder = async () => {
    const name = newFolder.trim()
    if (!name) return
    try {
      await apiJson('/api/folders', 'POST', { folder: name })
      setNewFolder('')
      show('資料夾已建立。', 'ok')
      await loadFolders()
      await selectFolder(name)
    } catch (error) {
      showError(error)
    }
  }

  const deleteFolder = async () => {
    if (folder === null) return
    const ok = await ask({
      title: '刪除資料夾',
      body: (
        <>
          <p>確定要刪除「{folder}」嗎？</p>
          <p>只有沒有圖檔的資料夾刪得掉；裡面還有東西的話伺服器會拒絕。</p>
        </>
      ),
      confirmLabel: '刪除資料夾',
    })
    if (!ok) return
    try {
      await api(`/api/folders/${encodeURIComponent(folder)}`, { method: 'DELETE' })
      show('資料夾已刪除。', 'ok')
      setFolder(null)
      setFiles([])
      setChoice({ ...defaultPrintChoice })
      setSummary('')
      await loadFolders()
    } catch (error) {
      showError(error)
    }
  }

  const deleteFile = async (item: StoredObject) => {
    if (folder === null) return
    const ok = await ask({
      title: '刪除圖片',
      body: (
        <>
          <p>確定要刪除「{item.name}」嗎？</p>
          <p>取件編號的快取會一併清除，下一次公開列印會產生新的編號。</p>
        </>
      ),
      confirmLabel: '刪除圖片',
    })
    if (!ok) return
    try {
      await api(`/api/objects?key=${encodeURIComponent(item.key)}`, { method: 'DELETE' })
      show('已刪除圖片，pincode 快取已清除；下次公開列印會建立新的取件編號。', 'ok')
      await loadFiles(folder)
    } catch (error) {
      showError(error)
    }
  }

  const changeSetting = async (key: keyof PrintChoice, value: string) => {
    if (folder === null) return
    const previous = choice
    const next = applyChoice(choice, key, value)
    setChoice(next)
    setSummary(`下一次列印將使用：${toSelectType(next)}`)
    try {
      const data = await apiJson<PrintSettingsResponse>('/api/print-settings', 'PUT', {
        folder,
        selectType: toSelectType(next),
      })
      setSummary(`目前規格：${data.printSpec}（${data.selectType}）`)
      if (data.cacheInvalidated) show('列印規格已更新，該資料夾的列印快取已清除。', 'ok')
    } catch (error) {
      setChoice(previous)
      setSummary(`目前規格：${toSelectType(previous)}`)
      showError(error)
    }
  }

  const acceptFiles = async (list: FileList | null) => {
    if (folder === null || uploading || !list) return
    const chosen = [...list]
    if (!chosen.length) return
    if (fileInput.current) fileInput.current.value = ''
    if (chosen.length > remaining) {
      show(`目前只剩 ${remaining} 個上傳名額，請減少選取的檔案。`, 'error')
      return
    }
    if (chosen.some((file) => !IMAGE_PATTERN.test(file.name))) {
      show('只可上傳 jpg、jpeg、png、bmp、gif 圖檔。', 'error')
      return
    }
    const total = chosen.reduce((sum, file) => sum + file.size, 0)
    const existingTotal = files.reduce((sum, file) => sum + file.size, 0)
    if (existingTotal + total > MAX_TOTAL_BYTES) {
      show('每個資料夾的圖檔總計不可超過 15 MB。', 'error')
      return
    }

    setUploading(true)
    setProgress({ label: `準備上傳 ${chosen.length} 個檔案…`, ratio: 0 })
    let completed = 0
    try {
      for (let index = 0; index < chosen.length; index += 1) {
        const file = chosen[index]!
        await uploadImage(folder, file, (loaded) =>
          setProgress({ label: `上傳中 ${index + 1} / ${chosen.length}：${file.name}`, ratio: (completed + loaded) / total }),
        )
        completed += file.size
        setProgress({ label: `已完成 ${index + 1} / ${chosen.length} 個檔案`, ratio: completed / total })
      }
      show('圖片已上傳，pincode 快取已清除；下次公開列印會建立新的取件編號。', 'ok')
    } catch (error) {
      showError(error)
    } finally {
      setUploading(false)
      setTimeout(() => setProgress(null), 500)
      // Files uploaded before the failure are already stored, so the listing
      // has to be re-read on both paths or the remaining quota goes stale.
      await loadFiles(folder).catch(showError)
    }
  }

  return (
    <AdminShell current="/ibon" message={message} onError={showError}>
      {dialog}

      <section class="grid">
        <div class="card">
          <h2>資料夾</h2>
          <p class="muted">資料夾名稱就是列印 API 的 id。</p>
          <div class="row">
            <input
              maxLength={128}
              placeholder="例如 20260721_soda"
              value={newFolder}
              onInput={(event) => setNewFolder(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void createFolder()
              }}
            />
            <button onClick={createFolder}>新增</button>
          </div>
          <ul class="folders">
            {!ready || folders.length === 0 ? (
              <li>{ready ? <EmptyState title="沒有資料夾" compact /> : <Spinner />}</li>
            ) : (
              folders.map((name) => (
                <li key={name} class={name === folder ? 'folder-row selected' : 'folder-row'}>
                  <button class="folder" onClick={() => selectFolder(name)}>
                    📁 {name}
                  </button>
                  <OpenButton url={printPageUrl(name)} label={`${name} 的列印頁`} />
                  <CopyButton url={printPageUrl(name)} label={`${name} 的列印頁`} onCopied={(label) => show(`已複製「${label}」的網址。`, 'ok')} onFailed={showError} />
                </li>
              ))
            )}
          </ul>
        </div>

        <div class="card">
          <h2>{folder === null ? '請選擇資料夾' : `資料夾：${folder}`}</h2>
          <p class="muted">可上傳 jpg、jpeg、png、bmp、gif；每個列印資料夾最多 8 張、總計 15 MB。</p>
          <p class="cache-notice">圖片上傳、刪除或列印規格異動時，會清除這個資料夾的 pincode 快取；下次公開列印將重新建立取件編號。</p>

          {folder !== null && (
            <section class="print-settings" aria-labelledby="print-settings-title">
              <div class="print-settings-header">
                <div>
                  <h2 id="print-settings-title">列印規格</h2>
                  <p class="muted">規格異動會清除目前資料夾的 ibon 快取。</p>
                </div>
              </div>
              <div class="setting-grid">
                {settingGroups.map((group) => (
                  <fieldset key={group.key}>
                    <legend>{group.legend}</legend>
                    <div class="choices">
                      {group.options.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          class={choice[group.key] === option.value ? 'choice selected' : 'choice'}
                          disabled={isOptionDisabled(choice, group.key, option.value)}
                          onClick={() => changeSetting(group.key, option.value)}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                ))}
              </div>
              <p class="print-summary">{summary}</p>
            </section>
          )}

          {folder !== null && !full && (
            <section class="upload-area" aria-label="圖片上傳">
              <input
                ref={fileInput}
                type="file"
                accept=".jpg,.jpeg,.png,.bmp,.gif"
                multiple
                hidden
                onChange={(event) => acceptFiles(event.currentTarget.files)}
              />
              <button
                type="button"
                class={dragging ? 'drop-zone drag-over' : 'drop-zone'}
                disabled={uploadDisabled}
                onClick={() => fileInput.current?.click()}
                onDragEnter={(event) => {
                  event.preventDefault()
                  if (!uploadDisabled) setDragging(true)
                }}
                onDragOver={(event) => {
                  event.preventDefault()
                  if (!uploadDisabled) setDragging(true)
                }}
                onDragLeave={(event) => {
                  event.preventDefault()
                  setDragging(false)
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  setDragging(false)
                  if (!uploadDisabled) void acceptFiles(event.dataTransfer?.files ?? null)
                }}
              >
                <span class="drop-zone-icon" aria-hidden="true">
                  ⇧
                </span>
                <span class="drop-zone-title">
                  拖曳檔案至此
                  <br />／點擊這裡選擇檔案即可上傳
                </span>
                <span class="drop-zone-hint">{`目前 ${files.length} / ${MAX_FILE_COUNT} 張，還可上傳 ${remaining} 張。`}</span>
              </button>
              {progress && (
                <div class="upload-progress" aria-live="polite">
                  <span class="upload-progress-label">{progress.label}</span>
                  <div class="progress-track">
                    <div class="progress-bar" style={{ width: `${Math.round(progress.ratio * 100)}%` }} />
                  </div>
                </div>
              )}
            </section>
          )}

          {full && <p class="upload-limit">已達上傳上限（8 / 8 張）。請先刪除圖檔後再上傳。</p>}

          <div class="folder-actions">
            <button class="danger" disabled={folder === null} onClick={deleteFolder}>
              刪除空資料夾
            </button>
          </div>

          <ul class="files">
            {folder === null ? (
              <li class="empty">尚未選擇資料夾</li>
            ) : files.length === 0 ? (
              <li class="empty">沒有圖檔</li>
            ) : (
              files.map((item) => (
                <li key={item.key}>
                  <div class="file-main">
                    <button
                      type="button"
                      class="file-thumb-btn"
                      onClick={() => setLightbox({ src: publicImageUrl(item.key), alt: item.name })}
                    >
                      <img class="file-thumb" src={thumbnailUrl(item.key, item.size)} alt={`${item.name} 縮圖`} loading="lazy" decoding="async" />
                    </button>
                    <span class="file-name">{`${item.name} (${fileSize(item.size)})`}</span>
                  </div>
                  <div class="file-actions">
                    <OpenButton url={publicImageUrl(item.key)} label={item.name} />
                    <CopyButton
                      url={publicImageUrl(item.key)}
                      label={`${item.name} 的公開圖檔`}
                      onCopied={(label) => show(`已複製「${label}」的網址。`, 'ok')}
                      onFailed={showError}
                    />
                    <button class="danger" onClick={() => deleteFile(item)}>
                      刪除
                    </button>
                  </div>
                </li>
              ))
            )}
          </ul>
        </div>
      </section>
      {lightbox && <Lightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />}
    </AdminShell>
  )
}
