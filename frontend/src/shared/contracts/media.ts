/** One image in the library. Blocks retain ids while renderers receive paths. */
export interface MediaItem {
  id: string
  path: string
  fileName: string
  title: string
  alt: string
  tags: string[]
  byteSize: number
  width: number
  height: number
  sizes: MediaSize[]
  createdAt: number
}

export interface MediaSize {
  label: 'small' | 'medium' | 'large'
  path: string
  width: number
  height: number
  byteSize: number
}
