import type {
  AboutConfig,
  AlbumConfig,
  BlockConfig,
  CarouselConfig,
  ContactConfig,
  MediaItem,
  MediaRef,
  PageBlock,
  ShopBlockConfig,
  TextBlockConfig,
} from '../../../../shared/types'

const asRef = (item: MediaItem): MediaRef => ({
  id: item.id,
  path: item.path,
  alt: item.alt,
  width: item.width,
  sizes: item.sizes,
})

/** Projects unsaved configs onto server blocks without losing older hydrated media. */
export function projectDraftBlocks(
  blocks: PageBlock[],
  drafts: Record<string, BlockConfig>,
  library: Map<string, MediaItem>,
): PageBlock[] {
  return blocks.map((block) => {
    const config = drafts[block.id] ?? block.config
    switch (block.type) {
      case 'carousel': {
        const draft = config as CarouselConfig
        return {
          ...block,
          config: draft,
          data: {
            slides: draft.slides
              .map((slide, index) => ({
                image: library.has(slide.mediaId) ? asRef(library.get(slide.mediaId)!) : block.data?.slides?.[index]?.image,
                caption: slide.caption,
                href: slide.href,
              }))
              .filter((slide): slide is { image: MediaRef; caption: string; href: string } => Boolean(slide.image)),
          },
        }
      }
      case 'album': {
        const draft = config as AlbumConfig
        return {
          ...block,
          config: draft,
          data: { images: draft.mediaIds.map((id, index) => library.has(id) ? asRef(library.get(id)!) : block.data?.images?.[index]).filter((image): image is MediaRef => Boolean(image)) },
        }
      }
      case 'about': {
        const draft = config as AboutConfig
        const item = draft.mediaId ? library.get(draft.mediaId) : undefined
        return { ...block, config: draft, data: { image: item ? asRef(item) : block.data?.image ?? null } }
      }
      case 'contact': {
        const draft = config as ContactConfig
        const item = draft.mediaId ? library.get(draft.mediaId) : undefined
        return { ...block, config: draft, data: { image: item ? asRef(item) : block.data?.image ?? null } }
      }
      case 'shop': return { ...block, config: config as ShopBlockConfig }
      default: return { ...block, config: config as TextBlockConfig }
    }
  })
}
