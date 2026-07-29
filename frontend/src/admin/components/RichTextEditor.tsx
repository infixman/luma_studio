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
  h2: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M4 5v14M4 12h8M12 5v14" />
      <path d="M16 17h5l-3-4a2 2 0 1 1 3.5-1.5" stroke-width="1.5" />
    </svg>
  ),
  h3: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M4 5v14M4 12h8M12 5v14" />
      <path d="M16 11.5a2 2 0 1 1 3.5 1.5 2 2 0 1 1-3.5 1.5" stroke-width="1.5" />
    </svg>
  ),
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
        <ToolButton icon={icons.link} label="插入連結" onClick={insertLink} />
        <ToolButton icon={icons.unlink} label="移除連結" onClick={removeLink} />
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
