import type { JSX } from 'preact'

import { apiUrl } from '../../shared/api'
import type {
  AboutConfig,
  AlbumConfig,
  BlockColumns,
  BlockConfig,
  BlockRatio,
  CarouselConfig,
  MediaItem,
  PageBlock,
  ShopBlockConfig,
  TextBlockConfig,
} from '../../shared/types'

/**
 * One editor per block type.
 *
 * Each takes the config it understands and hands back a new one — no block
 * knows about the page, and the page does not know what is inside a block.
 * That is what keeps adding a sixth type to a validator, a renderer and one
 * function here.
 *
 * Images are chosen through `pick`, which resolves when the owner has chosen
 * or dismissed the library. Editors store the id; `library` is only how a
 * thumbnail gets drawn beside it.
 */

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': 1.6,
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
} as const

/**
 * Each type's mark, shown on the collapsed row and in the picker.
 *
 * A row of identical rows distinguished only by a word is read one word at a
 * time; a shape is recognised without reading. That matters on a page with
 * eight blocks, which is the page this editor is for.
 */
const ICONS: Record<PageBlock['type'], JSX.Element> = {
  text: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M4 6h16M4 11h16M4 16h10" />
    </svg>
  ),
  carousel: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <rect x="6" y="5" width="12" height="14" rx="1.5" />
      <path d="M3 8v8M21 8v8" />
    </svg>
  ),
  album: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <rect x="3" y="4" width="7.5" height="7.5" rx="1" />
      <rect x="13.5" y="4" width="7.5" height="7.5" rx="1" />
      <rect x="3" y="14.5" width="7.5" height="5.5" rx="1" />
      <rect x="13.5" y="14.5" width="7.5" height="5.5" rx="1" />
    </svg>
  ),
  shop: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <path d="M3 5h2l2 10h10l2-7H6" />
      <circle cx="9" cy="19" r="1.3" />
      <circle cx="17" cy="19" r="1.3" />
    </svg>
  ),
  about: (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...stroke}>
      <circle cx="8.5" cy="9" r="3" />
      <path d="M3.5 19a5 5 0 0 1 10 0M16 8h5M16 12h5M16 16h3" />
    </svg>
  ),
}

export function BlockIcon({ type }: { type: PageBlock['type'] }) {
  return ICONS[type] ?? ICONS.text
}

export const BLOCK_KINDS: { type: PageBlock['type']; label: string; hint: string }[] = [
  { type: 'text', label: '純文字', hint: '條款、說明，支援 Markdown' },
  { type: 'carousel', label: '輪播圖', hint: '一次一張，可以放圖說與連結' },
  { type: 'album', label: '相簿', hint: '格狀排列的作品照片' },
  { type: 'shop', label: '商城', hint: '指定商品，或整個分類' },
  { type: 'about', label: '介紹', hint: '關於我、聯絡我：照片＋文字＋連結' },
]

/**
 * The line of content shown beside the type when a block is collapsed.
 *
 * Eight rows reading "純文字 / 輪播圖 / 相簿" tell somebody what the blocks are
 * but not which is which. A heading, or the first few words, is what they
 * actually recognise the block by.
 *
 * Empty is a real answer and says so, rather than leaving the row looking
 * like it failed to load.
 */
export function blockSummary(type: PageBlock['type'], config: BlockConfig): string {
  switch (type) {
    case 'text': {
      const body = (config as TextBlockConfig).body.replace(/[#*_>`\-]/g, '').trim()
      return body ? clip(body.split('\n')[0] ?? '', 60) : '（還沒有內容）'
    }
    case 'carousel': {
      const slides = (config as CarouselConfig).slides
      return slides.length ? `${slides.length} 張` : '（還沒有圖片）'
    }
    case 'album': {
      const ids = (config as AlbumConfig).mediaIds
      return ids.length ? `${ids.length} 張` : '（還沒有圖片）'
    }
    case 'shop': {
      const shop = config as ShopBlockConfig
      const what = shop.source === 'products' ? `指定 ${shop.slugs.length} 件商品` : `分類 ${shop.filter || '未指定'}`
      return shop.heading ? `${shop.heading} · ${what}` : what
    }
    case 'about': {
      const about = config as AboutConfig
      return about.heading || clip(about.body.trim(), 60) || '（還沒有內容）'
    }
    default:
      return ''
  }
}

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

export const RATIOS: { value: BlockRatio; label: string }[] = [
  { value: 'wide', label: '寬 16:9' },
  { value: 'square', label: '方 1:1' },
  { value: 'tall', label: '直 3:4' },
]

/** What a new block of each type starts as. Matches the API's own defaults. */
export function emptyConfig(type: PageBlock['type']): BlockConfig {
  switch (type) {
    case 'carousel':
      return { slides: [], ratio: 'wide', autoplay: false } satisfies CarouselConfig
    case 'album':
      return { mediaIds: [], columns: 3, ratio: 'square' } satisfies AlbumConfig
    case 'shop':
      return { heading: '', source: 'products', slugs: [], filter: '', limit: 8 } satisfies ShopBlockConfig
    case 'about':
      return { heading: '', body: '', mediaId: '', imageSide: 'left', links: [] } satisfies AboutConfig
    default:
      return { body: '' } satisfies TextBlockConfig
  }
}

export type PickImage = () => Promise<MediaItem | null>

export interface Catalogue {
  products: { slug: string; title: string }[]
  categories: { slug: string; title: string }[]
}

function Thumb({ mediaId, library }: { mediaId: string; library: Map<string, MediaItem> }) {
  const item = library.get(mediaId)
  // A block can outlive the picture it points at. Saying so beats an empty
  // square that looks like the editor failed to load.
  if (!item) return <span class="thumb missing">圖片已不存在</span>
  return <img class="thumb" src={apiUrl(item.path)} alt={item.alt} />
}

function Choices<T extends string | number>({
  legend,
  value,
  options,
  onPick,
}: {
  legend: string
  value: T
  options: { value: T; label: string }[]
  onPick: (next: T) => void
}) {
  return (
    <fieldset class="statuses choice-row">
      <legend>{legend}</legend>
      {options.map((option) => (
        <label key={option.value} class="radio">
          <input type="radio" checked={value === option.value} onChange={() => onPick(option.value)} />
          <span>{option.label}</span>
        </label>
      ))}
    </fieldset>
  )
}

export function TextEditor({ config, onChange }: { config: TextBlockConfig; onChange: (next: TextBlockConfig) => void }) {
  return (
    <textarea
      rows={10}
      maxLength={20000}
      value={config.body}
      placeholder={'# 標題\n\n一段文字。\n\n- 清單項目\n- 另一項\n\n**粗體**、[連結](https://example.com)'}
      onInput={(event) => onChange({ body: (event.target as HTMLTextAreaElement).value })}
    />
  )
}

export function CarouselEditor({
  config,
  onChange,
  library,
  pick,
}: {
  config: CarouselConfig
  onChange: (next: CarouselConfig) => void
  library: Map<string, MediaItem>
  pick: PickImage
}) {
  const slides = config.slides

  function edit(index: number, patch: Partial<CarouselConfig['slides'][number]>) {
    onChange({ ...config, slides: slides.map((slide, at) => (at === index ? { ...slide, ...patch } : slide)) })
  }

  async function add() {
    const item = await pick()
    if (item) onChange({ ...config, slides: [...slides, { mediaId: item.id, caption: '', href: '' }] })
  }

  async function replace(index: number) {
    const item = await pick()
    if (item) edit(index, { mediaId: item.id })
  }

  function move(index: number, by: number) {
    const to = index + by
    if (to < 0 || to >= slides.length) return
    const next = [...slides]
    next.splice(to, 0, ...next.splice(index, 1))
    onChange({ ...config, slides: next })
  }

  return (
    <div class="block-editor">
      <Choices
        legend="比例"
        value={config.ratio}
        options={RATIOS}
        onPick={(ratio) => onChange({ ...config, ratio })}
      />
      <label class="toggle">
        <input
          type="checkbox"
          checked={config.autoplay}
          onChange={(event) => onChange({ ...config, autoplay: (event.target as HTMLInputElement).checked })}
        />
        自動播放
      </label>
      {/* Said here rather than left to be discovered on the live page. */}
      <p class="muted">自動播放會在讀者還在看的時候換頁，通常關著比較好。</p>

      <ul class="slide-list">
        {slides.map((slide, index) => (
          <li key={`${slide.mediaId}-${index}`}>
            <Thumb mediaId={slide.mediaId} library={library} />
            <div class="fields">
              <input
                placeholder="圖說（可留空）"
                maxLength={120}
                value={slide.caption}
                onInput={(event) => edit(index, { caption: (event.target as HTMLInputElement).value })}
              />
              <input
                type="url"
                placeholder="點擊後前往（可留空）"
                value={slide.href}
                onInput={(event) => edit(index, { href: (event.target as HTMLInputElement).value })}
              />
            </div>
            <div class="controls">
              <button type="button" title="上移" disabled={index === 0} onClick={() => move(index, -1)}>
                ↑
              </button>
              <button
                type="button"
                title="下移"
                disabled={index === slides.length - 1}
                onClick={() => move(index, 1)}
              >
                ↓
              </button>
              <button type="button" onClick={() => void replace(index)}>
                換圖
              </button>
              <button
                type="button"
                class="danger"
                onClick={() => onChange({ ...config, slides: slides.filter((_, at) => at !== index) })}
              >
                移除
              </button>
            </div>
          </li>
        ))}
      </ul>

      <button type="button" onClick={() => void add()}>
        加一張
      </button>
    </div>
  )
}

export function AlbumEditor({
  config,
  onChange,
  library,
  pick,
}: {
  config: AlbumConfig
  onChange: (next: AlbumConfig) => void
  library: Map<string, MediaItem>
  pick: PickImage
}) {
  function move(index: number, by: number) {
    const to = index + by
    if (to < 0 || to >= config.mediaIds.length) return
    const next = [...config.mediaIds]
    next.splice(to, 0, ...next.splice(index, 1))
    onChange({ ...config, mediaIds: next })
  }

  async function add() {
    const item = await pick()
    if (item) onChange({ ...config, mediaIds: [...config.mediaIds, item.id] })
  }

  return (
    <div class="block-editor">
      <Choices
        legend="每列張數"
        value={config.columns}
        options={[2, 3, 4].map((value) => ({ value: value as BlockColumns, label: `${value} 張` }))}
        onPick={(columns) => onChange({ ...config, columns })}
      />
      <Choices legend="比例" value={config.ratio} options={RATIOS} onPick={(ratio) => onChange({ ...config, ratio })} />

      <ul class="album-list">
        {config.mediaIds.map((mediaId, index) => (
          <li key={`${mediaId}-${index}`}>
            <Thumb mediaId={mediaId} library={library} />
            <div class="controls">
              <button type="button" title="往前" disabled={index === 0} onClick={() => move(index, -1)}>
                ←
              </button>
              <button
                type="button"
                title="往後"
                disabled={index === config.mediaIds.length - 1}
                onClick={() => move(index, 1)}
              >
                →
              </button>
              <button
                type="button"
                class="danger"
                onClick={() => onChange({ ...config, mediaIds: config.mediaIds.filter((_, at) => at !== index) })}
              >
                移除
              </button>
            </div>
          </li>
        ))}
      </ul>

      <button type="button" onClick={() => void add()}>
        加一張
      </button>
    </div>
  )
}

export function ShopEditor({
  config,
  onChange,
  catalogue,
}: {
  config: ShopBlockConfig
  onChange: (next: ShopBlockConfig) => void
  catalogue: Catalogue
}) {
  const chosen = new Set(config.slugs)

  function toggleProduct(slug: string) {
    onChange({
      ...config,
      // Appending rather than re-sorting: the order they were chosen in is the
      // order they appear, which is the reason for naming them one by one.
      slugs: chosen.has(slug) ? config.slugs.filter((entry) => entry !== slug) : [...config.slugs, slug],
    })
  }

  function move(index: number, by: number) {
    const to = index + by
    if (to < 0 || to >= config.slugs.length) return
    const next = [...config.slugs]
    next.splice(to, 0, ...next.splice(index, 1))
    onChange({ ...config, slugs: next })
  }

  const titleOf = (slug: string) => catalogue.products.find((entry) => entry.slug === slug)?.title ?? slug

  return (
    <div class="block-editor">
      <label>
        標題（可留空）
        <input
          maxLength={80}
          value={config.heading}
          onInput={(event) => onChange({ ...config, heading: (event.target as HTMLInputElement).value })}
        />
      </label>

      <Choices
        legend="要顯示什麼"
        value={config.source}
        options={[
          { value: 'products' as const, label: '我選的商品' },
          { value: 'category' as const, label: '整個分類' },
        ]}
        onPick={(source) => onChange({ ...config, source })}
      />

      {config.source === 'products' ? (
        <>
          <ul class="chosen">
            {config.slugs.map((slug, index) => (
              <li key={slug}>
                <span>{titleOf(slug)}</span>
                <div class="controls">
                  <button type="button" disabled={index === 0} onClick={() => move(index, -1)}>
                    ↑
                  </button>
                  <button type="button" disabled={index === config.slugs.length - 1} onClick={() => move(index, 1)}>
                    ↓
                  </button>
                  <button type="button" class="danger" onClick={() => toggleProduct(slug)}>
                    移除
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <details>
            <summary>選商品（{catalogue.products.length}）</summary>
            <ul class="pick-list">
              {catalogue.products.map((product) => (
                <li key={product.slug}>
                  <label>
                    <input
                      type="checkbox"
                      checked={chosen.has(product.slug)}
                      onChange={() => toggleProduct(product.slug)}
                    />
                    {product.title}
                  </label>
                </li>
              ))}
            </ul>
          </details>
        </>
      ) : (
        <>
          <label>
            分類條件
            <input
              value={config.filter}
              placeholder="kits 或 kits,gifts 或 kits+gifts"
              onInput={(event) => onChange({ ...config, filter: (event.target as HTMLInputElement).value })}
            />
            <small>
              逗號是「任一」，加號是「兩者皆是」，跟分類頁網址同一套寫法。不能混用。
            </small>
          </label>
          <p class="muted">
            現有分類：{catalogue.categories.map((category) => category.slug).join('、') || '（還沒有分類）'}
          </p>
        </>
      )}

      <label>
        最多顯示
        <input
          type="number"
          min={1}
          max={24}
          value={config.limit}
          onInput={(event) => onChange({ ...config, limit: Number((event.target as HTMLInputElement).value) || 1 })}
        />
      </label>
    </div>
  )
}

export function AboutEditor({
  config,
  onChange,
  library,
  pick,
}: {
  config: AboutConfig
  onChange: (next: AboutConfig) => void
  library: Map<string, MediaItem>
  pick: PickImage
}) {
  function editLink(index: number, patch: Partial<AboutConfig['links'][number]>) {
    onChange({ ...config, links: config.links.map((link, at) => (at === index ? { ...link, ...patch } : link)) })
  }

  async function choose() {
    const item = await pick()
    if (item) onChange({ ...config, mediaId: item.id })
  }

  return (
    <div class="block-editor">
      <label>
        標題
        <input
          maxLength={80}
          value={config.heading}
          onInput={(event) => onChange({ ...config, heading: (event.target as HTMLInputElement).value })}
        />
      </label>

      <textarea
        rows={8}
        maxLength={4000}
        value={config.body}
        placeholder={'關於我，或聯絡方式。\n\n支援 Markdown。'}
        onInput={(event) => onChange({ ...config, body: (event.target as HTMLTextAreaElement).value })}
      />

      <div class="portrait-row">
        {config.mediaId ? <Thumb mediaId={config.mediaId} library={library} /> : <span class="thumb empty">沒有照片</span>}
        <div class="controls">
          <button type="button" onClick={() => void choose()}>
            {config.mediaId ? '換照片' : '選一張照片'}
          </button>
          {config.mediaId && (
            <button type="button" class="danger" onClick={() => onChange({ ...config, mediaId: '' })}>
              移除照片
            </button>
          )}
        </div>
      </div>

      {config.mediaId && (
        <Choices
          legend="照片放哪邊"
          value={config.imageSide}
          options={[
            { value: 'left' as const, label: '左邊' },
            { value: 'right' as const, label: '右邊' },
          ]}
          onPick={(imageSide) => onChange({ ...config, imageSide })}
        />
      )}

      <ul class="link-list">
        {config.links.map((link, index) => (
          <li key={index}>
            <input
              placeholder="文字"
              maxLength={30}
              value={link.label}
              onInput={(event) => editLink(index, { label: (event.target as HTMLInputElement).value })}
            />
            <input
              type="url"
              placeholder="https://"
              value={link.url}
              onInput={(event) => editLink(index, { url: (event.target as HTMLInputElement).value })}
            />
            <button
              type="button"
              class="danger"
              onClick={() => onChange({ ...config, links: config.links.filter((_, at) => at !== index) })}
            >
              移除
            </button>
          </li>
        ))}
      </ul>

      <button
        type="button"
        disabled={config.links.length >= 8}
        onClick={() => onChange({ ...config, links: [...config.links, { label: '', url: '' }] })}
      >
        加一個連結
      </button>
    </div>
  )
}
