import { useEffect, useRef, useState } from 'preact/hooks'

const COPIED_MS = 1800

const copyIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="9" y="9" width="11" height="11" rx="1" />
    <path d="M15 9V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h4" />
  </svg>
)

const checkIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="m5 12 4 4L19 6" />
  </svg>
)

const openIcon = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M14 4h6v6" />
    <path d="M20 4 12 12" />
    <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </svg>
)

async function writeToClipboard(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value)
    return
  }
  const field = document.createElement('textarea')
  field.value = value
  field.setAttribute('readonly', '')
  field.style.position = 'fixed'
  field.style.opacity = '0'
  document.body.append(field)
  field.select()
  const copied = document.execCommand('copy')
  field.remove()
  if (!copied) throw new Error('無法複製網址')
}

interface CopyButtonProps {
  url: string
  label: string
  onCopied: (label: string) => void
  onFailed: (error: unknown) => void
}

export function CopyButton({ url, label, onCopied, onFailed }: CopyButtonProps) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => () => clearTimeout(timer.current), [])

  const copy = async () => {
    try {
      await writeToClipboard(url)
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), COPIED_MS)
      onCopied(label)
    } catch (error) {
      onFailed(error)
    }
  }

  return (
    <button
      type="button"
      class={copied ? 'copy-link copied' : 'copy-link'}
      title={`複製${label}的網址`}
      aria-label={copied ? `已複製 ${label}` : `複製 ${label} 的網址`}
      onClick={copy}
    >
      {copied ? checkIcon : copyIcon}
    </button>
  )
}

export function OpenButton({ url, label }: { url: string; label: string }) {
  return (
    <a class="copy-link" href={url} target="_blank" rel="noopener noreferrer" title={`開新分頁：${label}`} aria-label={`開新分頁檢視 ${label}`}>
      {openIcon}
    </a>
  )
}
