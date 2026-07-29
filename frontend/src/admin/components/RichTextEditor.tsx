import type { JSX } from 'preact'
import { useCallback, useEffect, useRef, useState } from 'preact/hooks'

import { renderMarkdown } from '../../shared/markdown'
import type { TextBlockConfig } from '../../shared/types'
import { Button } from './ui/Button'
import { Modal } from './ui/Modal'
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
  underline: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M6 3v7a6 6 0 0 0 12 0V3M4 21h16" />
    </svg>
  ),
  strike: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M17 5.5A7 7 0 0 0 12 4c-3 0-5 1.3-5 3.5 0 1.6 1.1 2.5 3 3M7 18.5A8 8 0 0 0 12 20c3 0 5-1.3 5-3.5 0-1.7-1.2-2.6-3.2-3.2M3 12h18" />
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
  quote: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M5 17h4l2-5V6H5v6h3l-3 5ZM13 17h4l2-5V6h-6v6h3l-3 5Z" />
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
  link: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M10 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.6 1.6" />
      <path d="M14 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.6-1.6" />
    </svg>
  ),
  unlink: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M10 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.6 1.6" />
      <path d="M14 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.6-1.6M3 21 21 3" />
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
  hr: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M3 12h18" />
    </svg>
  ),
  table: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <rect x="3" y="4" width="18" height="16" rx="1" />
      <path d="M3 9h18M9 4v16M15 4v16M3 15h18" />
    </svg>
  ),
  search: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <circle cx="10.8" cy="10.8" r="6.8" />
      <path d="m16 16 4.5 4.5" />
    </svg>
  ),
  highlight: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="m14.8 4.2 5 5-9.2 9.2H5.8v-4.8z" />
      <path d="m13 6 5 5M4 21h16" />
    </svg>
  ),
  colour: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M12 3a9 9 0 1 0 0 18h1.5a1.5 1.5 0 0 0 0-3h-1a2 2 0 0 1 0-4h2a6.5 6.5 0 0 0 6.5-6.5C21 5 17 3 12 3Z" />
      <circle cx="7.5" cy="10" r="1" fill="currentColor" stroke="none" />
      <circle cx="10" cy="6.8" r="1" fill="currentColor" stroke="none" />
      <circle cx="14" cy="6.8" r="1" fill="currentColor" stroke="none" />
      <circle cx="17" cy="10" r="1" fill="currentColor" stroke="none" />
    </svg>
  ),
  undo: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="m9 7-5 5 5 5M5 12h8a6 6 0 0 1 6 6" />
    </svg>
  ),
  redo: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="m15 7 5 5-5 5M19 12h-8a6 6 0 0 0-6 6" />
    </svg>
  ),
  clear: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M4 7h16M10 11v6M14 11v6" />
      <path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3" />
    </svg>
  ),
  expand: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />
    </svg>
  ),
  collapse: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M3 8h5V3M21 8h-5V3M3 16h5v5M21 16h-5v5" />
    </svg>
  ),
}

const BLOCK_SELECTOR = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,div,td,th'
const EMPTY_HTML = new Set(['<br>', '<div><br></div>', '<p><br></p>'])
const FONT_SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 40, 48]
const TEXT_COLOURS = [
  { label: '墨黑', value: '#2b2622' },
  { label: '磚紅', value: '#b3261e' },
  { label: '琥珀', value: '#96551a' },
  { label: '森林綠', value: '#2f6b46' },
  { label: '深藍', value: '#1e5f86' },
  { label: '紫灰', value: '#66577a' },
]
const HIGHLIGHT_COLOURS = [
  { label: '柔黃', value: '#ffe37a' },
  { label: '薄荷綠', value: '#b8f0d0' },
  { label: '湖水藍', value: '#9de8f2' },
  { label: '櫻花粉', value: '#f3c2dc' },
  { label: '杏橘', value: '#ffd5a3' },
  { label: '淡紫', value: '#d7cef7' },
]

interface ToolbarState {
  block: string
  fontFamily: string
  fontSize: string
}

interface TableContext {
  table: HTMLTableElement
  cell: HTMLTableCellElement
}

interface TableProperties {
  title: string
  width: string
  borderColor: string
  borderWidth: string
}

type LinkTarget = '_blank' | '_self' | 'luma-link-window'

function htmlFromConfig(config: TextBlockConfig): string {
  return config.format === 'html' ? config.body : config.body ? renderMarkdown(config.body) : ''
}

function cleanEmptyHtml(html: string): string {
  const trimmed = html.trim().toLowerCase()
  return EMPTY_HTML.has(trimmed) ? '' : html
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
      aria-label={label}
      aria-pressed={active}
      onMouseDown={(event) => {
        event.preventDefault()
        onClick()
      }}
    >
      {icon}
    </button>
  )
}

function ToolbarSelect({
  label,
  value,
  options,
  onBeforeOpen,
  onChange,
}: {
  label: string
  value: string
  options: { value: string; label: string }[]
  onBeforeOpen: () => void
  onChange: (value: string) => void
}) {
  return (
    <label class="rte-select-label">
      <span class="sr-only">{label}</span>
      <select
        class="rte-select"
        aria-label={label}
        title={label}
        value={value}
        onMouseDown={onBeforeOpen}
        onChange={(event) => onChange((event.currentTarget as HTMLSelectElement).value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  )
}

function TableAction({
  children,
  label,
  disabled,
  onClick,
}: {
  children: string
  label?: string
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      class="rte-table-action"
      title={label ?? children}
      disabled={disabled}
      onMouseDown={(event) => {
        event.preventDefault()
        onClick()
      }}
    >
      {children}
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
  const savedRangeRef = useRef<Range | null>(null)
  const [mode, setMode] = useState<'visual' | 'source'>('visual')
  const [sourceDraft, setSourceDraft] = useState(() => htmlFromConfig(config))
  const [fullscreen, setFullscreen] = useState(false)
  const [toolbarState, setToolbarState] = useState<ToolbarState>({ block: '', fontFamily: '', fontSize: '' })
  const [tableContext, setTableContext] = useState<TableContext | null>(null)
  const tableContextRef = useRef<TableContext | null>(null)
  const [tablePropertiesOpen, setTablePropertiesOpen] = useState(false)
  const [tableProperties, setTableProperties] = useState<TableProperties>({
    title: '', width: '100%', borderColor: '#cbc1b5', borderWidth: '1px',
  })
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [replaceTerm, setReplaceTerm] = useState('')
  const [searchResult, setSearchResult] = useState({ index: -1, total: 0 })
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [colourMenuOpen, setColourMenuOpen] = useState(false)
  const [highlightMenuOpen, setHighlightMenuOpen] = useState(false)
  const [customTextColour, setCustomTextColour] = useState('#2b2622')
  const [linkDialogOpen, setLinkDialogOpen] = useState(false)
  const [linkDraft, setLinkDraft] = useState('https://')
  const [linkTarget, setLinkTarget] = useState<LinkTarget>('_blank')

  const findTableContext = useCallback((): TableContext | null => {
    const editor = editorRef.current
    const selection = window.getSelection()
    if (!editor || !selection || selection.rangeCount === 0) return null
    const cell = closestElement(selection.getRangeAt(0).startContainer)?.closest('td,th') as HTMLTableCellElement | null
    const table = cell?.closest('table') as HTMLTableElement | null
    return cell && table && editor.contains(table) ? { table, cell } : null
  }, [])

  const syncToolbarState = useCallback(() => {
    const selection = window.getSelection()
    const editor = editorRef.current
    if (!selection || !editor || selection.rangeCount === 0) return
    const anchor = closestElement(selection.getRangeAt(0).startContainer)
    if (!anchor || !editor.contains(anchor)) return

    const block = anchor.closest(BLOCK_SELECTOR) as HTMLElement | null
    const style = window.getComputedStyle(anchor instanceof HTMLElement ? anchor : block ?? editor)
    const fontSize = `${Math.round(Number.parseFloat(style.fontSize))}px`
    const fontFamily = style.fontFamily.replaceAll('"', '')
    setToolbarState((current) => {
      const next = {
        block: block?.tagName.toLowerCase() ?? '',
        fontFamily: fontFamily.includes('Noto Sans TC') || fontFamily.includes('Microsoft JhengHei')
          ? '"Noto Sans TC","Microsoft JhengHei",sans-serif'
          : fontFamily.includes('Noto Serif TC') || fontFamily.includes('PMingLiU')
            ? '"Noto Serif TC","PMingLiU",serif'
            : fontFamily.includes('DFKai-SB') || fontFamily.includes('BiauKai')
              ? '"DFKai-SB","BiauKai",cursive'
              : fontFamily.includes('Consolas') ? 'Consolas,monospace' : '',
        fontSize: FONT_SIZES.includes(Number.parseInt(fontSize, 10)) ? fontSize : '',
      }
      return current.block === next.block && current.fontFamily === next.fontFamily && current.fontSize === next.fontSize
        ? current : next
    })

    const nextTableContext = findTableContext()
    tableContextRef.current = nextTableContext
    setTableContext((current) => current?.table === nextTableContext?.table && current?.cell === nextTableContext?.cell
      ? current : nextTableContext)
  }, [findTableContext])

  const saveSelection = useCallback(() => {
    const editor = editorRef.current
    const selection = window.getSelection()
    if (!editor || !selection || selection.rangeCount === 0) return
    const range = selection.getRangeAt(0)
    if (editor.contains(range.commonAncestorContainer)) {
      savedRangeRef.current = range.cloneRange()
      syncToolbarState()
    }
  }, [syncToolbarState])

  const restoreSelection = useCallback(() => {
    const editor = editorRef.current
    const selection = window.getSelection()
    if (!editor || !selection) return false
    editor.focus()
    const saved = savedRangeRef.current
    if (!saved || !editor.contains(saved.commonAncestorContainer)) return false
    selection.removeAllRanges()
    selection.addRange(saved)
    return true
  }, [])

  const emitHtml = useCallback((html: string) => {
    const cleaned = cleanEmptyHtml(html)
    setSourceDraft(cleaned)
    onChange({ body: cleaned, format: 'html' })
  }, [onChange])

  const emitVisual = useCallback(() => {
    emitHtml(editorRef.current?.innerHTML ?? '')
    saveSelection()
  }, [emitHtml, saveSelection])

  useEffect(() => {
    const next = htmlFromConfig(config)
    const editor = editorRef.current
    setSourceDraft(next)
    if (editor && editor.innerHTML !== next) editor.innerHTML = next
  }, [config.body, config.format])

  useEffect(() => {
    const listener = () => saveSelection()
    document.addEventListener('selectionchange', listener)
    return () => document.removeEventListener('selectionchange', listener)
  }, [saveSelection])

  useEffect(() => {
    if (!fullscreen) return
    const listener = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFullscreen(false)
    }
    document.addEventListener('keydown', listener)
    return () => document.removeEventListener('keydown', listener)
  }, [fullscreen])

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus()
  }, [searchOpen])

  function exec(command: string, value?: string) {
    restoreSelection()
    document.execCommand(command, false, value)
    emitVisual()
  }

  function setBlock(tag: string) {
    restoreSelection()
    document.execCommand('formatBlock', false, tag)
    emitVisual()
  }

  function selectedBlocks(): HTMLElement[] {
    const editor = editorRef.current
    if (!editor) return []
    restoreSelection()
    const selection = window.getSelection()
    if (!selection || selection.rangeCount === 0) return []
    const range = selection.getRangeAt(0)
    const start = closestElement(range.startContainer)?.closest(BLOCK_SELECTOR) as HTMLElement | null
    if (range.collapsed && start && editor.contains(start)) return [start]

    return Array.from(editor.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)).filter((element) => {
      try {
        return range.intersectsNode(element)
      } catch {
        return false
      }
    })
  }

  function align(alignment: 'left' | 'center' | 'right') {
    let blocks = selectedBlocks()
    if (blocks.length === 0) {
      setBlock('p')
      blocks = selectedBlocks()
    }
    for (const block of blocks) block.style.textAlign = alignment
    emitVisual()
  }

  function replaceLegacyFonts(attribute: 'face' | 'size', cssProperty: 'fontFamily' | 'fontSize', value: string) {
    const editor = editorRef.current
    if (!editor) return
    for (const font of Array.from(editor.querySelectorAll<HTMLFontElement>(`font[${attribute}]`))) {
      const span = document.createElement('span')
      span.style[cssProperty] = value
      while (font.firstChild) span.appendChild(font.firstChild)
      font.replaceWith(span)
    }
  }

  function setFontFamily(fontFamily: string) {
    if (!fontFamily) return
    restoreSelection()
    document.execCommand('styleWithCSS', false, 'false')
    document.execCommand('fontName', false, fontFamily)
    replaceLegacyFonts('face', 'fontFamily', fontFamily)
    emitVisual()
  }

  function setFontSize(fontSize: string) {
    if (!fontSize) return
    restoreSelection()
    document.execCommand('styleWithCSS', false, 'false')
    document.execCommand('fontSize', false, '7')
    replaceLegacyFonts('size', 'fontSize', fontSize)
    emitVisual()
  }

  function highlightSelection(colour: string) {
    restoreSelection()
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) {
      alert('請先選取要標示的文字。')
      return
    }
    document.execCommand('styleWithCSS', false, 'true')
    document.execCommand('hiliteColor', false, colour)
    setHighlightMenuOpen(false)
    emitVisual()
  }

  function setTextColour(colour: string) {
    restoreSelection()
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) {
      alert('請先選取要變更顏色的文字。')
      return
    }
    document.execCommand('styleWithCSS', false, 'true')
    document.execCommand('foreColor', false, colour)
    setColourMenuOpen(false)
    emitVisual()
  }

  async function pickScreenColour() {
    type EyeDropperResult = { sRGBHex: string }
    type EyeDropperConstructor = new () => { open: () => Promise<EyeDropperResult> }
    const EyeDropper = (window as Window & { EyeDropper?: EyeDropperConstructor }).EyeDropper
    if (!EyeDropper) {
      alert('此瀏覽器不支援螢幕取色，請改用調色盤或輸入色碼。')
      return
    }
    try {
      const result = await new EyeDropper().open()
      setCustomTextColour(result.sRGBHex)
      setTextColour(result.sRGBHex)
    } catch {
      // Closing the picker is an expected cancellation, not an editor error.
    }
  }

  async function pickTableBorderColour() {
    type EyeDropperResult = { sRGBHex: string }
    type EyeDropperConstructor = new () => { open: () => Promise<EyeDropperResult> }
    const EyeDropper = (window as Window & { EyeDropper?: EyeDropperConstructor }).EyeDropper
    if (!EyeDropper) {
      alert('此瀏覽器不支援螢幕取色，請改用調色盤或輸入色碼。')
      return
    }
    try {
      const result = await new EyeDropper().open()
      setTableProperties((current) => ({ ...current, borderColor: result.sRGBHex }))
    } catch {
      // Closing the picker is an expected cancellation, not an editor error.
    }
  }

  function insertHtml(html: string) {
    restoreSelection()
    document.execCommand('insertHTML', false, html)
    emitVisual()
  }

  function insertLink() {
    restoreSelection()
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) {
      alert('請先選取要加上連結的文字。')
      return
    }
    saveSelection()
    const existing = findParentTag(selection.anchorNode, 'A') as HTMLAnchorElement | null
    setLinkDraft(existing?.getAttribute('href') ?? 'https://')
    setLinkTarget(safeLinkTarget(existing?.getAttribute('target')) ?? '_blank')
    setLinkDialogOpen(true)
  }

  function applyLink() {
    const value = linkDraft.trim()
    if (!value) {
      exec('unlink')
      setLinkDialogOpen(false)
      return
    }
    const href = safeUrl(value)
    if (!href) {
      alert('請輸入 https://、http://、mailto: 或本站相對路徑。')
      return
    }
    restoreSelection()
    document.execCommand('createLink', false, href)
    const anchor = findParentTag(window.getSelection()?.anchorNode ?? null, 'A') as HTMLAnchorElement | null
    if (anchor) {
      anchor.target = linkTarget
      if (linkTarget === '_blank') anchor.rel = 'noopener noreferrer'
      else anchor.removeAttribute('rel')
    }
    emitVisual()
    setLinkDialogOpen(false)
  }

  function closeLinkDialog() {
    setLinkDialogOpen(false)
    restoreSelection()
  }

  function insertImage() {
    saveSelection()
    const src = prompt('圖片網址', 'https://')
    if (!src?.trim()) return
    const href = prompt('點擊圖片要前往的連結（可留空）', '')
    const image = `<img src="${escapeAttribute(src.trim())}" alt="">`
    insertHtml(href?.trim() ? `<a href="${escapeAttribute(href.trim())}">${image}</a>` : image)
  }

  function insertEmbed() {
    saveSelection()
    const url = prompt('貼上 YouTube、Instagram 或 Facebook 連結', 'https://')
    if (!url?.trim()) return
    const iframe = buildEmbed(url.trim())
    if (!iframe) {
      alert('無法辨識這個連結，目前支援 YouTube、Instagram、Facebook。')
      return
    }
    insertHtml(iframe)
  }

  function insertTable(value: string) {
    if (!value) return
    const [rows, columns] = value.split('x').map(Number)
    if (!rows || !columns) return
    insertHtml(buildTable(rows, columns))
  }

  function changeTable(mutator: (context: TableContext) => void) {
    restoreSelection()
    const context = findTableContext() ?? tableContextRef.current
    if (!context) return
    mutator(context)
    emitVisual()
    syncToolbarState()
  }

  function insertTableRow(position: 'above' | 'below') {
    changeTable(({ cell }) => {
      const row = cell.parentElement as HTMLTableRowElement | null
      if (!row) return
      const nextRow = document.createElement('tr')
      for (const currentCell of Array.from(row.cells)) {
        const nextCell = document.createElement(currentCell.tagName.toLowerCase())
        nextCell.innerHTML = '<br>'
        nextRow.appendChild(nextCell)
      }
      row.insertAdjacentElement(position === 'above' ? 'beforebegin' : 'afterend', nextRow)
    })
  }

  function deleteTableRow() {
    changeTable(({ table, cell }) => {
      if (table.rows.length > 1) cell.parentElement?.remove()
    })
  }

  function insertTableColumn(position: 'left' | 'right') {
    changeTable(({ table, cell }) => {
      const row = cell.parentElement as HTMLTableRowElement | null
      if (!row) return
      const column = Array.from(row.cells).indexOf(cell)
      for (const currentRow of Array.from(table.rows)) {
        const reference = currentRow.cells[column] ?? null
        const nextCell = document.createElement((reference?.tagName ?? 'TD').toLowerCase())
        nextCell.innerHTML = '<br>'
        currentRow.insertBefore(nextCell, position === 'left' ? reference : reference?.nextSibling ?? null)
      }
    })
  }

  function deleteTableColumn() {
    changeTable(({ table, cell }) => {
      const row = cell.parentElement as HTMLTableRowElement | null
      if (!row || row.cells.length <= 1) return
      const column = Array.from(row.cells).indexOf(cell)
      for (const currentRow of Array.from(table.rows)) currentRow.cells[column]?.remove()
    })
  }

  function openTableProperties() {
    restoreSelection()
    const context = findTableContext() ?? tableContextRef.current
    if (!context) return
    const sampleCell = context.table.querySelector<HTMLTableCellElement>('th,td')
    setTableProperties({
      title: context.table.title,
      width: context.table.style.width || '100%',
      borderColor: sampleCell?.style.borderColor || '#cbc1b5',
      borderWidth: sampleCell?.style.borderWidth || '1px',
    })
    setTablePropertiesOpen(true)
  }

  function applyTableProperties() {
    const width = normalizeTableWidth(tableProperties.width)
    const borderColor = normalizeColor(tableProperties.borderColor)
    const borderWidth = normalizeBorderWidth(tableProperties.borderWidth)
    if (!width || !borderColor || !borderWidth) return

    changeTable(({ table }) => {
      table.title = tableProperties.title.trim()
      table.style.width = width
      for (const cell of Array.from(table.querySelectorAll<HTMLTableCellElement>('th,td'))) {
        cell.style.borderStyle = 'solid'
        cell.style.borderColor = borderColor
        cell.style.borderWidth = borderWidth
      }
    })
    setTablePropertiesOpen(false)
  }

  function searchMatches(query: string): Range[] {
    const editor = editorRef.current
    if (!editor || !query) return []
    const matches: Range[] = []
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    let node: Text | null
    while ((node = walker.nextNode() as Text | null)) {
      const value = node.data
      let from = 0
      while (from <= value.length - query.length) {
        const index = value.toLocaleLowerCase().indexOf(query.toLocaleLowerCase(), from)
        if (index < 0) break
        const range = document.createRange()
        range.setStart(node, index)
        range.setEnd(node, index + query.length)
        matches.push(range)
        from = index + Math.max(query.length, 1)
      }
    }
    return matches
  }

  function selectSearchMatch(nextIndex: number) {
    const query = searchTerm.trim()
    const matches = searchMatches(query)
    if (matches.length === 0) {
      setSearchResult({ index: -1, total: 0 })
      return
    }
    const index = ((nextIndex % matches.length) + matches.length) % matches.length
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(matches[index]!)
    savedRangeRef.current = matches[index]!.cloneRange()
    setSearchResult({ index, total: matches.length })
    syncToolbarState()
  }

  function findNext(direction: 1 | -1 = 1) {
    selectSearchMatch(searchResult.index + direction)
  }

  function replaceCurrent() {
    const query = searchTerm.trim()
    const matches = searchMatches(query)
    if (matches.length === 0) return
    const index = searchResult.index < 0 ? 0 : searchResult.index % matches.length
    const range = matches[index]!
    range.deleteContents()
    const replacement = document.createTextNode(replaceTerm)
    range.insertNode(replacement)
    const selection = window.getSelection()
    const nextRange = document.createRange()
    nextRange.setStartAfter(replacement)
    nextRange.collapse(true)
    selection?.removeAllRanges()
    selection?.addRange(nextRange)
    savedRangeRef.current = nextRange.cloneRange()
    emitVisual()
    selectSearchMatch(index)
  }

  function replaceAll() {
    const query = searchTerm.trim()
    const matches = searchMatches(query)
    if (matches.length === 0) return
    for (const range of matches.reverse()) {
      range.deleteContents()
      range.insertNode(document.createTextNode(replaceTerm))
    }
    emitVisual()
    selectSearchMatch(0)
  }

  function closeSearch() {
    setSearchOpen(false)
    restoreSelection()
  }

  function clearFormatting() {
    exec('removeFormat')
    for (const block of selectedBlocks()) {
      block.style.removeProperty('text-align')
    }
    emitVisual()
  }

  function handlePaste(event: ClipboardEvent) {
    event.preventDefault()
    const html = event.clipboardData?.getData('text/html')
    const text = event.clipboardData?.getData('text/plain') ?? ''
    insertHtml(html ? sanitizeEditorHtml(html) : escapeHtml(text).replace(/\n/g, '<br>'))
  }

  function handleEditorClick(event: MouseEvent) {
    saveSelection()
    setColourMenuOpen(false)
    setHighlightMenuOpen(false)
    const editor = editorRef.current
    const cell = closestElement(event.target as Node)?.closest('td,th') as HTMLTableCellElement | null
    const table = cell?.closest('table') as HTMLTableElement | null
    if (!editor || !cell || !table || !editor.contains(table)) return
    const context = { table, cell }
    tableContextRef.current = context
    setTableContext(context)
  }

  function handleKeyDown(event: KeyboardEvent) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      setSearchOpen(true)
      return
    }
    if (event.key !== 'Enter' || event.shiftKey) return
    const block = document.queryCommandValue('formatBlock')
    if (block && /^h[1-6]$/i.test(block)) {
      event.preventDefault()
      exec('formatBlock', 'p')
      document.execCommand('insertParagraph', false)
      emitVisual()
    }
  }

  function switchMode(next: 'visual' | 'source') {
    if (next === mode) return
    if (next === 'source') {
      const html = editorRef.current?.innerHTML ?? ''
      setSourceDraft(html)
      emitHtml(html)
    } else {
      const safe = sanitizeEditorHtml(sourceDraft)
      if (editorRef.current) editorRef.current.innerHTML = safe
      emitHtml(safe)
    }
    setMode(next)
  }

  function commitSource() {
    const safe = sanitizeEditorHtml(sourceDraft)
    setSourceDraft(safe)
    if (editorRef.current) editorRef.current.innerHTML = safe
    emitHtml(safe)
  }

  return (
    <div class={`rte-wrap${fullscreen ? ' is-fullscreen' : ''}`}>
      <div class="rte-topbar">
        <div class="rte-tabs" role="tablist" aria-label="編輯模式">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'visual'}
            class={mode === 'visual' ? 'is-active' : ''}
            onClick={() => switchMode('visual')}
          >
            視覺編輯
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'source'}
            class={mode === 'source' ? 'is-active' : ''}
            onClick={() => switchMode('source')}
          >
            HTML
          </button>
        </div>
        <ToolButton
          icon={fullscreen ? icons.collapse : icons.expand}
          label={fullscreen ? '離開全螢幕 (Esc)' : '全螢幕編輯'}
          onClick={() => setFullscreen((current) => !current)}
        />
      </div>

      {mode === 'visual' && (
        <div class="rte-toolbar" role="toolbar" aria-label="格式工具列">
          <div class="rte-tool-group">
            <ToolButton icon={icons.undo} label="復原 (Ctrl+Z)" onClick={() => exec('undo')} />
            <ToolButton icon={icons.redo} label="重做 (Ctrl+Y)" onClick={() => exec('redo')} />
          </div>
          <span class="rte-sep" />
          <div class="rte-tool-group">
            <ToolbarSelect
              label="段落格式"
              value={toolbarState.block}
              onBeforeOpen={saveSelection}
              onChange={setBlock}
              options={[
                { value: '', label: '段落格式' },
                { value: 'h1', label: '標題 1' },
                { value: 'h2', label: '標題 2' },
                { value: 'h3', label: '標題 3' },
                { value: 'h4', label: '標題 4' },
                { value: 'h5', label: '標題 5' },
                { value: 'h6', label: '標題 6' },
                { value: 'p', label: '內文' },
              ]}
            />
            <ToolbarSelect
              label="字型"
              value={toolbarState.fontFamily}
              onBeforeOpen={saveSelection}
              onChange={setFontFamily}
              options={[
                { value: '', label: '字型' },
                { value: '"Noto Sans TC","Microsoft JhengHei",sans-serif', label: '黑體' },
                { value: '"Noto Serif TC","PMingLiU",serif', label: '明體' },
                { value: '"DFKai-SB","BiauKai",cursive', label: '楷體' },
                { value: 'Consolas,monospace', label: '等寬' },
              ]}
            />
            <ToolbarSelect
              label="字體大小"
              value={toolbarState.fontSize}
              onBeforeOpen={saveSelection}
              onChange={setFontSize}
              options={[
                { value: '', label: '字級' },
                ...FONT_SIZES.map((size) => ({
                  value: `${size}px`,
                  label: `${size}px`,
                })),
              ]}
            />
          </div>
          <span class="rte-sep" />
          <div class="rte-tool-group">
            <ToolButton icon={icons.bold} label="粗體 (Ctrl+B)" onClick={() => exec('bold')} />
            <ToolButton icon={icons.italic} label="斜體 (Ctrl+I)" onClick={() => exec('italic')} />
            <ToolButton icon={icons.underline} label="底線 (Ctrl+U)" onClick={() => exec('underline')} />
            <ToolButton icon={icons.strike} label="刪除線" onClick={() => exec('strikeThrough')} />
            <div class="rte-colour-control">
              <ToolButton icon={icons.highlight} label="螢光筆" onClick={() => setHighlightMenuOpen((current) => !current)} />
              {highlightMenuOpen && (
                <div class="rte-colour-menu rte-highlight-menu" role="menu" aria-label="螢光筆顏色">
                  <span>螢光筆顏色</span>
                  <div>
                    {HIGHLIGHT_COLOURS.map((colour) => (
                      <button
                        key={colour.value}
                        type="button"
                        role="menuitem"
                        title={colour.label}
                        aria-label={colour.label}
                        style={{ '--rte-colour': colour.value }}
                        onMouseDown={(event) => {
                          event.preventDefault()
                          highlightSelection(colour.value)
                        }}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
          <span class="rte-sep" />
          <div class="rte-tool-group">
            <ToolButton icon={icons.ul} label="無序清單" onClick={() => exec('insertUnorderedList')} />
            <ToolButton icon={icons.ol} label="有序清單" onClick={() => exec('insertOrderedList')} />
            <ToolButton icon={icons.quote} label="引用" onClick={() => setBlock('blockquote')} />
          </div>
          <span class="rte-sep" />
          <div class="rte-tool-group">
            <ToolButton icon={icons.alignLeft} label="靠左" onClick={() => align('left')} />
            <ToolButton icon={icons.alignCenter} label="置中" onClick={() => align('center')} />
            <ToolButton icon={icons.alignRight} label="靠右" onClick={() => align('right')} />
          </div>
          <span class="rte-sep" />
          <div class="rte-tool-group">
            <div class="rte-colour-control">
              <ToolButton icon={icons.colour} label="文字顏色" onClick={() => setColourMenuOpen((current) => !current)} />
              {colourMenuOpen && (
                <div class="rte-colour-menu" role="menu" aria-label="文字顏色">
                  <span>文字顏色</span>
                  <div>
                    {TEXT_COLOURS.map((colour) => (
                      <button
                        key={colour.value}
                        type="button"
                        role="menuitem"
                        title={colour.label}
                        aria-label={colour.label}
                        style={{ '--rte-colour': colour.value }}
                        onMouseDown={(event) => {
                          event.preventDefault()
                          setTextColour(colour.value)
                        }}
                      />
                    ))}
                  </div>
                  <div class="rte-colour-custom">
                    <span>自訂色</span>
                    <div>
                      <input
                        type="color"
                        aria-label="從調色盤選擇文字顏色"
                        value={normalizeColor(customTextColour) ?? '#2b2622'}
                        onInput={(event) => {
                          const colour = (event.currentTarget as HTMLInputElement).value
                          setCustomTextColour(colour)
                          setTextColour(colour)
                        }}
                      />
                      <input
                        aria-label="自訂文字顏色色碼"
                        value={customTextColour}
                        placeholder="#2b2622"
                        onInput={(event) => setCustomTextColour((event.currentTarget as HTMLInputElement).value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && normalizeColor(customTextColour)) {
                            event.preventDefault()
                            setTextColour(customTextColour)
                          }
                        }}
                      />
                      <button
                        type="button"
                        disabled={!normalizeColor(customTextColour)}
                        onMouseDown={(event) => {
                          event.preventDefault()
                          setTextColour(customTextColour)
                        }}
                      >套用</button>
                    </div>
                    <button type="button" class="rte-eyedropper" onClick={pickScreenColour}>螢幕取色</button>
                  </div>
                </div>
              )}
            </div>
            <ToolButton icon={icons.link} label="插入連結" onClick={insertLink} />
            <ToolButton icon={icons.unlink} label="移除連結" onClick={() => exec('unlink')} />
            <ToolButton icon={icons.image} label="插入圖片" onClick={insertImage} />
            <ToolButton icon={icons.embed} label="嵌入 YouTube / IG / FB" onClick={insertEmbed} />
            <ToolButton icon={icons.hr} label="水平分隔線" onClick={() => insertHtml('<hr><p><br></p>')} />
            <ToolButton icon={icons.search} label="搜尋與取代 (Ctrl+F)" onClick={() => setSearchOpen(true)} />
            <label class="rte-table-control" title="插入表格">
              <span class="rte-table-icon" aria-hidden="true">{icons.table}</span>
              <select
                aria-label="插入表格"
                value=""
                onMouseDown={saveSelection}
                onChange={(event) => insertTable((event.currentTarget as HTMLSelectElement).value)}
              >
                <option value="">表格</option>
                <option value="2x2">2 × 2</option>
                <option value="3x2">3 × 2</option>
                <option value="3x3">3 × 3</option>
                <option value="4x3">4 × 3</option>
                <option value="4x4">4 × 4</option>
              </select>
            </label>
          </div>
          <span class="rte-sep" />
          <ToolButton icon={icons.clear} label="清除格式" onClick={clearFormatting} />
        </div>
      )}

      {mode === 'visual' && tableContext && (
        <div class="rte-table-toolbar" role="toolbar" aria-label="表格工具列">
          <span class="rte-table-context">表格編輯</span>
          <div class="rte-table-actions">
            <TableAction onClick={() => insertTableRow('above')}>上方插入列</TableAction>
            <TableAction onClick={() => insertTableRow('below')}>下方插入列</TableAction>
            <TableAction disabled={tableContext.table.rows.length <= 1} onClick={deleteTableRow}>刪除列</TableAction>
            <span class="rte-table-sep" />
            <TableAction onClick={() => insertTableColumn('left')}>左方插入欄</TableAction>
            <TableAction onClick={() => insertTableColumn('right')}>右方插入欄</TableAction>
            <TableAction disabled={tableContext.cell.parentElement?.children.length === 1} onClick={deleteTableColumn}>刪除欄</TableAction>
            <span class="rte-table-sep" />
            <TableAction onClick={openTableProperties}>表格屬性</TableAction>
          </div>
        </div>
      )}

      {mode === 'visual' && searchOpen && (
        <div class="rte-search-bar" role="search" aria-label="搜尋與取代">
          <input
            ref={searchInputRef}
            aria-label="搜尋文字"
            placeholder="搜尋"
            value={searchTerm}
            onInput={(event) => {
              setSearchTerm((event.currentTarget as HTMLInputElement).value)
              setSearchResult({ index: -1, total: 0 })
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                findNext(event.shiftKey ? -1 : 1)
              }
              if (event.key === 'Escape') closeSearch()
            }}
          />
          <input
            aria-label="取代為"
            placeholder="取代為"
            value={replaceTerm}
            onInput={(event) => setReplaceTerm((event.currentTarget as HTMLInputElement).value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') closeSearch()
            }}
          />
          <span class="rte-search-count" aria-live="polite">
            {searchTerm.trim() ? (searchResult.total ? `${searchResult.index + 1} / ${searchResult.total}` : '找不到') : '輸入關鍵字'}
          </span>
          <div class="rte-search-actions">
            <button type="button" onClick={() => findNext(-1)} disabled={!searchTerm.trim()} aria-label="上一筆">‹</button>
            <button type="button" onClick={() => findNext(1)} disabled={!searchTerm.trim()} aria-label="下一筆">›</button>
            <button type="button" onClick={replaceCurrent} disabled={searchResult.total === 0}>取代</button>
            <button type="button" onClick={replaceAll} disabled={searchResult.total === 0}>全部取代</button>
          </div>
          <button type="button" class="rte-search-close" onClick={closeSearch} aria-label="關閉搜尋與取代">×</button>
        </div>
      )}

      <div
        ref={editorRef}
        class={`rte-content${mode === 'visual' ? '' : ' is-hidden'}`}
        contentEditable={mode === 'visual'}
        role="textbox"
        aria-multiline="true"
        aria-label="文字內容"
        onInput={emitVisual}
        onFocus={saveSelection}
        onClick={handleEditorClick as any}
        onMouseUp={saveSelection}
        onKeyUp={saveSelection}
        onPaste={handlePaste as any}
        onKeyDown={handleKeyDown as any}
      />

      {mode === 'source' && (
        <textarea
          class="rte-source"
          aria-label="HTML 原始碼"
          spellcheck={false}
          value={sourceDraft}
          onInput={(event) => setSourceDraft((event.currentTarget as HTMLTextAreaElement).value)}
          onBlur={commitSource}
        />
      )}
      <div class="rte-status">
        {mode === 'source'
          ? '切回視覺編輯時會移除不安全的標籤與屬性。'
          : tableContext
            ? `目前在表格第 ${Array.from(tableContext.table.rows).indexOf(tableContext.cell.parentElement as HTMLTableRowElement) + 1} 列；可直接調整列、欄與邊框。`
            : '游標所在位置會同步顯示段落、字型與字級；選取文字後可套用格式。'}
      </div>

      <Modal
        title="表格屬性"
        open={tablePropertiesOpen}
        onClose={() => setTablePropertiesOpen(false)}
        footer={
          <>
            <Button tone="ghost" onClick={() => setTablePropertiesOpen(false)}>取消</Button>
            <Button tone="primary" onClick={applyTableProperties}>套用</Button>
          </>
        }
      >
        <div class="rte-table-properties">
          <label>標題
            <input value={tableProperties.title} onInput={(event) => setTableProperties((current) => ({ ...current, title: (event.currentTarget as HTMLInputElement).value }))} />
          </label>
          <label>寬度
            <input value={tableProperties.width} inputMode="decimal" placeholder="100% 或 720px" onInput={(event) => setTableProperties((current) => ({ ...current, width: (event.currentTarget as HTMLInputElement).value }))} />
          </label>
          <label>邊框顏色
            <span class="rte-table-colour-field">
              <input
                type="color"
                aria-label="從調色盤選擇邊框顏色"
                value={normalizeColor(tableProperties.borderColor) ?? '#cbc1b5'}
                onInput={(event) => setTableProperties((current) => ({ ...current, borderColor: (event.currentTarget as HTMLInputElement).value }))}
              />
              <input
                aria-label="邊框顏色色碼"
                value={tableProperties.borderColor}
                placeholder="#cbc1b5"
                onInput={(event) => setTableProperties((current) => ({ ...current, borderColor: (event.currentTarget as HTMLInputElement).value }))}
              />
              <button type="button" onClick={pickTableBorderColour}>螢幕取色</button>
            </span>
          </label>
          <label>邊框寬度
            <input value={tableProperties.borderWidth} inputMode="decimal" placeholder="1px" onInput={(event) => setTableProperties((current) => ({ ...current, borderWidth: (event.currentTarget as HTMLInputElement).value }))} />
          </label>
          <p>寬度支援百分比或 px；邊框顏色可從調色盤、螢幕取色或輸入 3／6 碼色碼。設為 0px 時，編輯器會顯示虛線輔助框。</p>
        </div>
      </Modal>

      <Modal
        title="插入連結"
        open={linkDialogOpen}
        onClose={closeLinkDialog}
        footer={
          <>
            <Button tone="ghost" onClick={closeLinkDialog}>取消</Button>
            <Button tone="primary" onClick={applyLink}>套用連結</Button>
          </>
        }
      >
        <div class="rte-table-properties rte-link-properties">
          <label>連結網址
            <input
              value={linkDraft}
              placeholder="https://example.com"
              onInput={(event) => setLinkDraft((event.currentTarget as HTMLInputElement).value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') applyLink()
              }}
            />
          </label>
          <label>開啟方式
            <select aria-label="連結開啟方式" value={linkTarget} onChange={(event) => setLinkTarget((event.currentTarget as HTMLSelectElement).value as LinkTarget)}>
              <option value="_blank">新分頁（預設）</option>
              <option value="luma-link-window">新視窗</option>
              <option value="_self">原視窗</option>
            </select>
          </label>
          <p>支援 https://、http://、mailto: 與本站相對路徑；留空並套用可移除連結。新視窗的實際呈現由使用者瀏覽器設定決定。</p>
        </div>
      </Modal>
    </div>
  )
}

function closestElement(node: Node | null): Element | null {
  if (!node) return null
  return node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement
}

function findParentTag(node: Node | null, tag: string): HTMLElement | null {
  let current = node
  while (current) {
    if (current.nodeType === Node.ELEMENT_NODE && (current as HTMLElement).tagName === tag) {
      return current as HTMLElement
    }
    current = current.parentNode
  }
  return null
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function escapeAttribute(value: string): string {
  return escapeHtml(value)
}

function normalizeTableWidth(value: string): string | null {
  const trimmed = value.trim()
  return /^(?:\d{1,3}(?:\.\d{1,2})?%|\d{1,4}(?:\.\d{1,2})?px)$/.test(trimmed) ? trimmed : null
}

function normalizeColor(value: string): string | null {
  const trimmed = value.trim()
  return /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(trimmed) ? trimmed : null
}

function normalizeBorderWidth(value: string): string | null {
  const trimmed = value.trim()
  return /^(?:0|[1-9]\d?(?:\.\d)?px)$/.test(trimmed) ? trimmed : null
}

function buildTable(rows: number, columns: number): string {
  const head = Array.from({ length: columns }, (_, index) => `<th>欄位 ${index + 1}</th>`).join('')
  const body = Array.from({ length: Math.max(1, rows - 1) }, () => (
    `<tr>${Array.from({ length: columns }, () => '<td><br></td>').join('')}</tr>`
  )).join('')
  return (
    '<div style="overflow:auto"><table style="width:100%;border-collapse:collapse">'
    + `<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div><p><br></p>`
  )
}

const KEEP_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'STRONG', 'B', 'EM', 'I', 'U', 'S',
  'SPAN', 'A', 'UL', 'OL', 'LI', 'BR', 'HR', 'BLOCKQUOTE', 'IMG', 'DIV', 'IFRAME',
  'TABLE', 'THEAD', 'TBODY', 'TR', 'TH', 'TD',
])

const STYLE_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SPAN', 'LI', 'BLOCKQUOTE', 'DIV',
  'IFRAME', 'TABLE', 'TH', 'TD',
])

function sanitizeEditorHtml(html: string): string {
  const parser = new DOMParser()
  const doc = parser.parseFromString(html, 'text/html')

  function clean(node: Node): DocumentFragment {
    const fragment = document.createDocumentFragment()
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        fragment.appendChild(document.createTextNode(child.textContent ?? ''))
        continue
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue

      const element = child as HTMLElement
      const tag = element.tagName
      if (tag === 'SCRIPT' || tag === 'STYLE') continue
      if (!KEEP_TAGS.has(tag)) {
        fragment.appendChild(clean(element))
        continue
      }

      const mapped = tag === 'B' ? 'STRONG' : tag === 'I' ? 'EM' : tag
      const kept = document.createElement(mapped)
      if (tag === 'A') {
        const href = safeUrl(element.getAttribute('href'))
        if (href) kept.setAttribute('href', href)
        const target = safeLinkTarget(element.getAttribute('target'))
        if (target) {
          kept.setAttribute('target', target)
          if (target === '_blank') kept.setAttribute('rel', 'noopener noreferrer')
        }
      }
      if (tag === 'IMG') {
        const src = safeUrl(element.getAttribute('src'))
        if (src) kept.setAttribute('src', src)
        kept.setAttribute('alt', element.getAttribute('alt') ?? '')
      }
      if (tag === 'IFRAME') {
        const src = safeEmbedUrl(element.getAttribute('src'))
        if (src) kept.setAttribute('src', src)
        if (element.hasAttribute('allowfullscreen')) kept.setAttribute('allowfullscreen', '')
      }
      if (tag === 'TABLE' && element.getAttribute('title')) {
        kept.setAttribute('title', element.getAttribute('title') ?? '')
      }
      if (STYLE_TAGS.has(tag) && element.getAttribute('style')) {
        const safe = sanitizeInlineStyle(element.getAttribute('style') ?? '')
        if (safe) kept.setAttribute('style', safe)
      }
      kept.appendChild(clean(element))
      fragment.appendChild(kept)
    }
    return fragment
  }

  const wrapper = document.createElement('div')
  wrapper.appendChild(clean(doc.body))
  return wrapper.innerHTML
}

const SAFE_STYLE_PROPS = new Set([
  'text-align', 'position', 'width', 'height', 'padding-bottom', 'overflow',
  'top', 'left', 'border', 'border-collapse', 'font-family', 'font-size',
  'text-decoration', 'color', 'background-color', 'border-color', 'border-width', 'border-style',
])

function sanitizeInlineStyle(raw: string): string {
  return raw
    .split(';')
    .map((declaration) => declaration.trim())
    .filter((declaration) => {
      if (!declaration || !declaration.includes(':')) return false
      const [property, ...valueParts] = declaration.split(':')
      if (!property) return false
      const normalizedProperty = property.trim().toLowerCase()
      const value = valueParts.join(':').trim().toLowerCase()
      return SAFE_STYLE_PROPS.has(normalizedProperty)
        && isSafeStyleValue(normalizedProperty, value)
    })
    .join(';')
}

function isSafeStyleValue(property: string, value: string): boolean {
  if (value.includes('\\') || value.includes('url(') || value.includes('expression(')) return false
  if (property === 'text-align') return ['left', 'center', 'right', 'justify'].includes(value)
  if (property === 'position') return ['relative', 'absolute'].includes(value)
  if (property === 'overflow') return ['hidden', 'auto', 'scroll'].includes(value)
  if (['width', 'height', 'padding-bottom', 'top', 'left', 'font-size'].includes(property)) {
    return /^(?:0|(?:\d{1,3}(?:\.\d{1,2})?)(?:px|rem|em|%))$/.test(value)
  }
  if (property === 'border') return value === '0'
  if (property === 'color') return /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/.test(value)
    || /^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/.test(value)
  if (property === 'background-color') return /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/.test(value)
    || /^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/.test(value)
  if (property === 'border-color') return /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/.test(value)
  if (property === 'border-width') return /^(?:0|[1-9]\d?(?:\.\d)?px)$/.test(value)
  if (property === 'border-style') return value === 'solid'
  if (property === 'border-collapse') return ['collapse', 'separate'].includes(value)
  if (property === 'font-family') return /^[\w\s"',-]+$/.test(value)
  if (property === 'text-decoration') return ['none', 'underline', 'line-through'].includes(value)
  return false
}

function safeUrl(raw: string | null): string {
  const value = raw?.trim() ?? ''
  return /^(https?:\/\/|mailto:|\/)/i.test(value) ? value : ''
}

function safeLinkTarget(raw: string | null): LinkTarget | null {
  return raw === '_blank' || raw === '_self' || raw === 'luma-link-window' ? raw : null
}

function safeEmbedUrl(raw: string | null): string {
  const value = safeUrl(raw)
  if (!value) return ''
  try {
    const host = new URL(value, window.location.origin).hostname
    return [
      'youtube.com', 'www.youtube.com', 'instagram.com', 'www.instagram.com',
      'facebook.com', 'www.facebook.com',
    ].includes(host) ? value : ''
  } catch {
    return ''
  }
}

const EMBED_STYLE = 'position:relative;width:100%;padding-bottom:56.25%;height:0;overflow:hidden'
const IFRAME_STYLE = 'position:absolute;top:0;left:0;width:100%;height:100%;border:0'

function buildEmbed(url: string): string | null {
  let match: RegExpMatchArray | null

  match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]+)/)
  if (match) {
    return `<div style="${EMBED_STYLE}"><iframe src="https://www.youtube.com/embed/${match[1]}" style="${IFRAME_STYLE}" allowfullscreen></iframe></div><p><br></p>`
  }

  match = url.match(/instagram\.com\/(?:p|reel)\/([\w-]+)/)
  if (match) {
    return `<div style="${EMBED_STYLE}"><iframe src="https://www.instagram.com/p/${match[1]}/embed/" style="${IFRAME_STYLE}"></iframe></div><p><br></p>`
  }

  if (/facebook\.com\//.test(url)) {
    const encoded = encodeURIComponent(url)
    return `<div style="${EMBED_STYLE}"><iframe src="https://www.facebook.com/plugins/post.php?href=${encoded}&show_text=true" style="${IFRAME_STYLE}"></iframe></div><p><br></p>`
  }

  return null
}
