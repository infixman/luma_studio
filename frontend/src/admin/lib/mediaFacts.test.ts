import { describe, expect, it } from 'vitest'

import { fileSize, mediaCaption, mediaDimensions, mediaFormat, mediaName, mediaSrcSet } from './mediaFacts'
import type { MediaItem } from '../../shared/types'

function item(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: 'mediaid1234',
    path: '/media-assets/abc123.png',
    fileName: 'cat.png',
    title: '',
    alt: '',
    tags: [],
    byteSize: 2048,
    width: 1024,
    height: 1024,
    sizes: [],
    createdAt: 1700000000,
    ...overrides,
  }
}

describe('mediaName', () => {
  it('prefers the owner’s own label', () => {
    expect(mediaName(item({ title: '首頁主圖' }))).toBe('首頁主圖')
  })

  it('falls back to the file name, because an empty title is a normal answer', () => {
    expect(mediaName(item())).toBe('cat.png')
  })
})

describe('fileSize', () => {
  it('stays in bytes below a kilobyte', () => {
    expect(fileSize(900)).toBe('900 B')
  })

  it('rounds kilobytes and keeps one decimal for megabytes', () => {
    expect(fileSize(2048)).toBe('2 KB')
    expect(fileSize(1024 * 1024 * 2.5)).toBe('2.5 MB')
  })
})

describe('mediaFormat', () => {
  it('reads the extension and shouts it', () => {
    expect(mediaFormat(item({ fileName: 'cat.png' }))).toBe('PNG')
    expect(mediaFormat(item({ fileName: 'Cat.JPEG' }))).toBe('JPEG')
  })

  it('says nothing for a name with no extension', () => {
    expect(mediaFormat(item({ fileName: 'image' }))).toBe('')
  })

  it('takes the last dot, not the first', () => {
    expect(mediaFormat(item({ fileName: 'cat.v2.webp' }))).toBe('WEBP')
  })
})

describe('mediaDimensions', () => {
  it('writes the pair with the multiplication sign, not an x', () => {
    expect(mediaDimensions(item())).toBe('1024×1024')
  })

  it('says nothing rather than 0×0 when nobody measured it', () => {
    // Uploaded before the browser started measuring, or undecodable.
    expect(mediaDimensions(item({ width: 0, height: 0 }))).toBe('')
  })
})

describe('mediaCaption', () => {
  it('is the line under a thumbnail', () => {
    expect(mediaCaption(item())).toBe('PNG · 1024×1024')
  })

  it('drops the separator along with whichever half is missing', () => {
    expect(mediaCaption(item({ width: 0, height: 0 }))).toBe('PNG')
    expect(mediaCaption(item({ fileName: 'image', width: 0, height: 0 }))).toBe('')
  })
})

describe('mediaSrcSet', () => {
  const sizes: MediaItem['sizes'] = [
    { label: 'small', path: '/media-assets/s.webp', width: 480, height: 480, byteSize: 100 },
    { label: 'medium', path: '/media-assets/m.webp', width: 960, height: 960, byteSize: 200 },
  ]

  it('offers the stored widths and the original above them', () => {
    // Without the original, a wide screen would be handed the 960 copy of a
    // 1024 image and nothing larger would exist.
    const set = mediaSrcSet(item({ sizes }))
    expect(set.split(', ').map((entry) => entry.split(' ')[1])).toEqual(['480w', '960w', '1024w'])
  })

  it('is empty when there is nothing to choose between', () => {
    // A one-entry srcset only repeats what src already says.
    expect(mediaSrcSet(item())).toBe('')
  })

  it('leaves the original out when its width was never measured', () => {
    // A srcset entry with no width is one the browser cannot rank.
    expect(mediaSrcSet(item({ sizes, width: 0, height: 0 }))).not.toContain('abc123.png')
  })
})
