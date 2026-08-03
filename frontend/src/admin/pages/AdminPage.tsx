import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

import { writeToClipboard } from '../components/IconButtons'
import { Lightbox } from '../components/Lightbox'
import { AdminShell } from '../components/AdminShell'
import { useStatus } from '../components/StatusBar'
import { Button, EmptyState, Menu, MenuItem, Modal, Panel, Spinner, TextField, useConfirm } from '../components/ui'
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

const MAX_FILE_COUNT = 8
const MAX_TOTAL_BYTES = 15 * 1024 * 1024
const IMAGE_PATTERN = /\.(jpg|jpeg|png|bmp|gif)$/i

/** Named because the submit button sits in the dialog's own footer and points at it. */
const CREATE_FORM = 'new-folder'

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
  const [creatingFolder, setCreatingFolder] = useState(false)
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

  /** Returns whether it actually happened, so the dialog knows whether to close. */
  const createFolder = async (): Promise<boolean> => {
    const name = newFolder.trim()
    if (!name) return false
    try {
      await apiJson('/api/folders', 'POST', { folder: name })
      setNewFolder('')
      show('資料夾已建立。', 'ok')
      await loadFolders()
      await selectFolder(name)
      return true
    } catch (error) {
      showError(error)
      return false
    }
  }

  const submitCreateFolder = async (event: Event) => {
    event.preventDefault()
    if (await createFolder()) setCreatingFolder(false)
  }

  const deleteFolder = async (target: string) => {
    const ok = await ask({
      title: '刪除資料夾',
      body: (
        <>
          <p>確定要刪除「{target}」嗎？</p>
          <p>只有沒有圖檔的資料夾刪得掉；裡面還有東西的話伺服器會拒絕。</p>
        </>
      ),
      confirmLabel: '刪除資料夾',
    })
    if (!ok) return
    try {
      await api(`/api/folders/${encodeURIComponent(target)}`, { method: 'DELETE' })
      show('資料夾已刪除。', 'ok')
      if (folder === target) {
        setFolder(null)
        setFiles([])
        setChoice({ ...defaultPrintChoice })
        setSummary('')
      }
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

  const copyUrl = async (label: string, url: string) => {
    try {
      await writeToClipboard(url)
      show(`已複製「${label}」的網址。`, 'ok')
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

      <div class="ibon-layout">
        <Panel
          title="資料夾"
          actions={
            <Button tone="primary" size="sm" onClick={() => setCreatingFolder(true)}>
              新增資料夾
            </Button>
          }
        >
          {!ready ? (
            <Spinner />
          ) : folders.length === 0 ? (
            <EmptyState title="沒有資料夾" compact />
          ) : (
            <ul class="ibon-folders">
              {folders.map((name) => (
                <li key={name} class={name === folder ? 'is-selected' : ''}>
                  <button type="button" class="ibon-folder-name" onClick={() => selectFolder(name)}>
                    {name}
                  </button>
                  <Menu label={`${name} 的操作`}>
                    <MenuItem onClick={() => window.open(printPageUrl(name), '_blank', 'noopener,noreferrer')}>
                      開啟列印頁
                    </MenuItem>
                    <MenuItem onClick={() => void copyUrl(`${name} 的列印頁`, printPageUrl(name))}>
                      複製網址
                    </MenuItem>
                    <MenuItem tone="danger" onClick={() => void deleteFolder(name)}>
                      刪除資料夾
                    </MenuItem>
                  </Menu>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {folder === null ? (
          <Panel>
            <EmptyState title="尚未選擇資料夾" body="從左邊選一個資料夾，開始設定列印規格或上傳圖片。" />
          </Panel>
        ) : (
          <div class="ibon-folder-detail">
            <Panel title={`列印規格：${folder}`}>
              <div class="ibon-setting-grid">
                {settingGroups.map((group) => (
                  <fieldset key={group.key}>
                    <legend>{group.legend}</legend>
                    <div class="ibon-choices">
                      {group.options.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          class={choice[group.key] === option.value ? 'ibon-choice is-selected' : 'ibon-choice'}
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
              <p class="ui-note">{summary}</p>
            </Panel>

            <Panel title="圖片">
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
                class={dragging ? 'ibon-dropzone drag-over' : 'ibon-dropzone'}
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
                <span class="ibon-dropzone-title">拖曳檔案至此，或點擊選擇檔案</span>
                <span class="ibon-dropzone-hint">
                  {full
                    ? '已達上傳上限，請先刪除圖檔再上傳'
                    : `可上傳 jpg／jpeg／png／bmp／gif，目前 ${files.length} / ${MAX_FILE_COUNT} 張，還可上傳 ${remaining} 張（總計 15 MB 內）`}
                </span>
              </button>
              {progress && (
                <div class="ibon-upload-progress" aria-live="polite">
                  <span>{progress.label}</span>
                  <div class="ibon-progress-track">
                    <div class="ibon-progress-bar" style={{ width: `${Math.round(progress.ratio * 100)}%` }} />
                  </div>
                </div>
              )}

              {files.length === 0 ? (
                <EmptyState title="沒有圖檔" compact />
              ) : (
                <ul class="ibon-files">
                  {files.map((item) => (
                    <li key={item.key}>
                      <button
                        type="button"
                        class="ibon-file-thumb-btn"
                        onClick={() => setLightbox({ src: publicImageUrl(item.key), alt: item.name })}
                      >
                        <img
                          class="ibon-file-thumb"
                          src={thumbnailUrl(item.key, item.size)}
                          alt={`${item.name} 縮圖`}
                          loading="lazy"
                          decoding="async"
                        />
                      </button>
                      <span class="ibon-file-name">{`${item.name}（${fileSize(item.size)}）`}</span>
                      <Menu label={`${item.name} 的操作`}>
                        <MenuItem onClick={() => window.open(publicImageUrl(item.key), '_blank', 'noopener,noreferrer')}>
                          開啟原始圖檔
                        </MenuItem>
                        <MenuItem onClick={() => void copyUrl(`${item.name} 的公開圖檔`, publicImageUrl(item.key))}>
                          複製圖檔網址
                        </MenuItem>
                        <MenuItem tone="danger" onClick={() => void deleteFile(item)}>
                          刪除圖片
                        </MenuItem>
                      </Menu>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
        )}
      </div>

      <Modal
        title="新增資料夾"
        open={creatingFolder}
        onClose={() => setCreatingFolder(false)}
        footer={
          <>
            <Button tone="ghost" onClick={() => setCreatingFolder(false)}>
              取消
            </Button>
            <Button type="submit" form={CREATE_FORM} tone="primary" disabled={newFolder.trim() === ''}>
              新增
            </Button>
          </>
        }
      >
        <form id={CREATE_FORM} onSubmit={submitCreateFolder}>
          <TextField
            label="資料夾名稱"
            hint="這個名稱就是列印 API 的 id，例如 20260721_soda"
            maxLength={128}
            value={newFolder}
            onInput={(event) => setNewFolder((event.currentTarget as HTMLInputElement).value)}
          />
        </form>
      </Modal>

      {lightbox && <Lightbox src={lightbox.src} alt={lightbox.alt} onClose={() => setLightbox(null)} />}
    </AdminShell>
  )
}
