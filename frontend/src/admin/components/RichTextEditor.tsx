import { useRef, useEffect, useCallback } from 'preact/hooks'
import type { JSX } from 'preact'

import { renderMarkdown } from '../../shared/markdown'
import type { TextBlockConfig } from '../../shared/types'
import '../styles/rich-text.css'

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': 1.8,
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
} as const

const icons = {
  bold: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M6 4h7a4 4 0 0 1 0 8H6zM6 12h8a4 4 0 0 1 0 8H6z" />
    </svg>
  ),
  italic: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M10 4h8M6 20h8M14 4l-4 16" />
    </svg>
  ),
  h2: (<span class="rte-text-icon">大標</span>),
  h3: (<span class="rte-text-icon">小標</span>),
  ul: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <circle cx="4.5" cy="6" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="4.5" cy="18" r="1.2" fill="currentColor" stroke="none" />
    </svg>
  ),
  ol: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M10 6h10M10 12h10M10 18h10" />
      <text x="4" y="8" font-size="7" fill="currentColor" stroke="none" font-weight="600">1</text>
      <text x="4" y="14" font-size="7" fill="currentColor" stroke="none" font-weight="600">2</text>
      <text x="4" y="20" font-size="7" fill="currentColor" stroke="none" font-weight="600">3</text>
    </svg>
  ),
  link: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M10 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.6 1.6" />
      <path d="M14 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.6-1.6" />
    </svg>
  ),
  unlink: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M10 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.6 1.6" />
      <path d="M14 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.6-1.6" />
      <path d="M3 21 21 3" stroke-width="2" />
    </svg>
  ),
  alignLeft: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M3 6h18M3 10h12M3 14h18M3 18h12" />
    </svg>
  ),
  alignCenter: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M3 6h18M6 10h12M3 14h18M6 18h12" />
    </svg>
  ),
  alignRight: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M3 6h18M9 10h12M3 14h18M9 18h12" />
    </svg>
  ),
  image: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none" />
      <path d="m21 15-5-5L5 21" />
    </svg>
  ),
  embed: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="m7 8-4 4 4 4M17 8l4 4-4 4M14 4l-4 16" />
    </svg>
  ),
  clear: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M4 7h16M10 11v6M14 11v6" />
      <path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" />
    </svg>
  ),
}

function ToolButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: JSX.Element
  label: string
  active?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      class={`rte-btn${active ? ' is-active' : ''}`}
      title={label}
      onMouseDown={(e) => {
        e.preventDefault()
        onClick()
      }}
    >
      {icon}
    </button>
  )
}

export function RichTextEditor({
  config,
  onChange,
}: {
  config: TextBlockConfig
  onChange: (next: TextBlockConfig) => void
}) {
  const editorRef = useRef<HTMLDivElement>(null)
  const initialised = useRef(false)

  useEffect(() => {
    if (!editorRef.current || initialised.current) return
    initialised.current = true
    const html =
      config.format === 'html' ? config.body : config.body ? renderMarkdown(config.body) : ''
    editorRef.current.innerHTML = html
  }, [])

  const emit = useCallback(() => {
    const html = editorRef.current?.innerHTML ?? ''
    const cleaned = html === '<br>' || html === '<div><br></div>' ? '' : html
    onChange({ body: cleaned, format: 'html' })
  }, [onChange])

  function exec(command: string, value?: string) {
    document.execCommand(command, false, value)
    editorRef.current?.focus()
    emit()
  }

  function toggleBlock(tag: string) {
    const current = document.queryCommandValue('formatBlock')
    if (current.toLowerCase() === tag.toLowerCase()) {
      exec('formatBlock', 'p')
    } else {
      exec('formatBlock', tag)
    }
  }

  function insertLink() {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) return

    const existing = findParentTag(selection.anchorNode, 'A') as HTMLAnchorElement | null
    const href = prompt('連結網址', existing?.href ?? 'https://')
    if (href === null) return

    if (!href.trim()) {
      exec('unlink')
    } else {
      exec('createLink', href)
    }
  }

  function removeLink() {
    exec('unlink')
  }

  function insertImage() {
    const src = prompt('圖片網址', 'https://')
    if (!src?.trim()) return
    const href = prompt('點擊圖片要前往的連結（可留空）', '')
    const img = document.createElement('img')
    img.src = src.trim()
    img.alt = ''
    if (href?.trim()) {
      const a = document.createElement('a')
      a.href = href.trim()
      a.appendChild(img)
      document.execCommand('insertHTML', false, a.outerHTML)
    } else {
      exec('insertImage', src.trim())
    }
    emit()
  }

  function insertEmbed() {
    const url = prompt('貼上 YouTube、Instagram 或 Facebook 連結', 'https://')
    if (!url?.trim()) return
    const iframe = buildEmbed(url.trim())
    if (!iframe) {
      alert('無法辨識這個連結，目前支援 YouTube、Instagram、Facebook')
      return
    }
    document.execCommand('insertHTML', false, iframe)
    emit()
  }

  function clearFormatting() {
    exec('removeFormat')
    exec('formatBlock', 'p')
  }

  function handlePaste(e: ClipboardEvent) {
    e.preventDefault()
    const html = e.clipboardData?.getData('text/html')
    const text = e.clipboardData?.getData('text/plain') ?? ''

    if (html) {
      const cleaned = stripPastedHTML(html)
      document.execCommand('insertHTML', false, cleaned)
    } else {
      document.execCommand('insertText', false, text)
    }
    emit()
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      const block = document.queryCommandValue('formatBlock')
      if (block && /^h[2-4]$/i.test(block)) {
        e.preventDefault()
        exec('formatBlock', 'p')
        document.execCommand('insertParagraph', false)
      }
    }
  }

  return (
    <div class="rte-wrap">
      <div class="rte-toolbar" role="toolbar" aria-label="格式工具列">
        <ToolButton icon={icons.bold} label="粗體 (Ctrl+B)" onClick={() => exec('bold')} />
        <ToolButton icon={icons.italic} label="斜體 (Ctrl+I)" onClick={() => exec('italic')} />
        <span class="rte-sep" />
        <ToolButton icon={icons.h2} label="標題 H2" onClick={() => toggleBlock('h2')} />
        <ToolButton icon={icons.h3} label="標題 H3" onClick={() => toggleBlock('h3')} />
        <span class="rte-sep" />
        <ToolButton icon={icons.ul} label="無序清單" onClick={() => exec('insertUnorderedList')} />
        <ToolButton icon={icons.ol} label="有序清單" onClick={() => exec('insertOrderedList')} />
        <span class="rte-sep" />
        <ToolButton icon={icons.alignLeft} label="置左" onClick={() => exec('justifyLeft')} />
        <ToolButton icon={icons.alignCenter} label="置中" onClick={() => exec('justifyCenter')} />
        <ToolButton icon={icons.alignRight} label="置右" onClick={() => exec('justifyRight')} />
        <span class="rte-sep" />
        <ToolButton icon={icons.link} label="插入連結" onClick={insertLink} />
        <ToolButton icon={icons.unlink} label="移除連結" onClick={removeLink} />
        <ToolButton icon={icons.image} label="插入圖片" onClick={insertImage} />
        <ToolButton icon={icons.embed} label="嵌入 YouTube / IG / FB" onClick={insertEmbed} />
        <span class="rte-sep" />
        <ToolButton icon={icons.clear} label="清除格式" onClick={clearFormatting} />
      </div>
      <div
        ref={editorRef}
        class="rte-content"
        contentEditable
        role="textbox"
        aria-multiline="true"
        aria-label="文字內容"
        onInput={emit}
        onPaste={handlePaste as any}
        onKeyDown={handleKeyDown as any}
      />
    </div>
  )
}

function findParentTag(node: Node | null, tag: string): HTMLElement | null {
  let current = node
  while (current) {
    if (current.nodeType === 1 && (current as HTMLElement).tagName === tag) {
      return current as HTMLElement
    }
    current = current.parentNode
  }
  return null
}

function stripPastedHTML(html: string): string {
  const parser = new DOMParser()
  const doc = parser.parseFromString(html, 'text/html')

  const KEEP = new Set([
    'P',
    'H2',
    'H3',
    'H4',
    'STRONG',
    'B',
    'EM',
    'I',
    'A',
    'UL',
    'OL',
    'LI',
    'BR',
    'BLOCKQUOTE',
    'IMG',
    'DIV',
    'IFRAME',
  ])

  function clean(node: Node): DocumentFragment {
    const frag = document.createDocumentFragment()

    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        frag.appendChild(document.createTextNode(child.textContent ?? ''))
        continue
      }
      if (child.nodeType !== 1) continue

      const el = child as HTMLElement
      const tag = el.tagName

      if (KEEP.has(tag)) {
        let mapped = tag
        if (tag === 'B') mapped = 'STRONG'
        if (tag === 'I') mapped = 'EM'

        const kept = document.createElement(mapped)
        if (tag === 'A') {
          const href = el.getAttribute('href')
          if (href) kept.setAttribute('href', href)
        }
        if (tag === 'IMG') {
          const src = el.getAttribute('src')
          if (src) kept.setAttribute('src', src)
          kept.setAttribute('alt', el.getAttribute('alt') ?? '')
        }
        if (tag === 'IFRAME') {
          const src = el.getAttribute('src')
          if (src) kept.setAttribute('src', src)
          if (el.hasAttribute('allowfullscreen')) kept.setAttribute('allowfullscreen', '')
        }
        if ((tag === 'DIV' || tag === 'IFRAME' || tag === 'P') && el.getAttribute('style')) {
          const safe = sanitizePastedStyle(el.getAttribute('style')!)
          if (safe) kept.setAttribute('style', safe)
        }
        kept.appendChild(clean(el))
        frag.appendChild(kept)
      } else {
        frag.appendChild(clean(el))
      }
    }
    return frag
  }

  const result = clean(doc.body)
  const wrapper = document.createElement('div')
  wrapper.appendChild(result)
  return wrapper.innerHTML
}

const SAFE_STYLE_PROPS = new Set([
  'text-align', 'position', 'width', 'height', 'padding-bottom',
  'overflow', 'top', 'left', 'border',
])

function sanitizePastedStyle(raw: string): string {
  return raw
    .split(';')
    .map((d) => d.trim())
    .filter((d) => {
      if (!d || !d.includes(':')) return false
      const prop = d.slice(0, d.indexOf(':')).trim().toLowerCase()
      const val = d.slice(d.indexOf(':') + 1).trim()
      return SAFE_STYLE_PROPS.has(prop) && !val.includes('\\') && !val.toLowerCase().includes('url(')
    })
    .join(';')
}

const EMBED_STYLE = 'position:relative;width:100%;padding-bottom:56.25%;height:0;overflow:hidden'
const IFRAME_STYLE = 'position:absolute;top:0;left:0;width:100%;height:100%;border:0'

function buildEmbed(url: string): string | null {
  let m: RegExpMatchArray | null

  m = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]+)/)
  if (m) {
    return `<div style="${EMBED_STYLE}"><iframe src="https://www.youtube.com/embed/${m[1]}" style="${IFRAME_STYLE}" allowfullscreen></iframe></div><p></p>`
  }

  m = url.match(/instagram\.com\/(?:p|reel)\/([\w-]+)/)
  if (m) {
    return `<div style="${EMBED_STYLE}"><iframe src="https://www.instagram.com/p/${m[1]}/embed/" style="${IFRAME_STYLE}"></iframe></div><p></p>`
  }

  m = url.match(/facebook\.com\//)
  if (m) {
    const encoded = encodeURIComponent(url)
    return `<div style="${EMBED_STYLE}"><iframe src="https://www.facebook.com/plugins/post.php?href=${encoded}&show_text=true" style="${IFRAME_STYLE}"></iframe></div><p></p>`
  }

  return null
}
