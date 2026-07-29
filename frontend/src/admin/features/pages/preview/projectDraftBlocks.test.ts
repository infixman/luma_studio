import { describe, expect, it } from 'vitest'

import { projectDraftBlocks } from './projectDraftBlocks'
import type { MediaItem, PageBlock } from '../../../../shared/types'

const image: MediaItem = {
  id: 'media-1', path: '/images/one.jpg', fileName: 'one.jpg', title: 'one', alt: 'one', tags: [], byteSize: 1,
  width: 800, height: 600, sizes: [], createdAt: 0,
}

describe('projectDraftBlocks', () => {
  it('uses a local media record for a newly drafted carousel slide', () => {
    const blocks: PageBlock[] = [{
      id: 'block-1', position: 0, type: 'carousel',
      config: { slides: [], ratio: 'wide', autoplay: false },
    }]
    const projected = projectDraftBlocks(blocks, {
      'block-1': { slides: [{ mediaId: image.id, caption: 'caption', href: '' }], ratio: 'wide', autoplay: false },
    }, new Map([[image.id, image]]))

    const block = projected[0]!
    expect(block.type === 'carousel' && block.data?.slides?.[0]).toMatchObject({ image: { id: image.id }, caption: 'caption' })
  })

  it('keeps hydrated media when an older asset is outside the loaded library', () => {
    const blocks: PageBlock[] = [{
      id: 'block-1', position: 0, type: 'album',
      config: { mediaIds: ['old'], columns: 3, ratio: 'square' },
      data: { images: [image] },
    }]
    const projected = projectDraftBlocks(blocks, {}, new Map())

    const block = projected[0]!
    expect(block.type === 'album' && block.data?.images).toMatchObject([{ id: image.id }])
  })
})
