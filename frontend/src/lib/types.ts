export interface PrintResult {
  id: string
  pincode: string
  deadline: string
  qrCodeSvg: string
  files: string[]
  selectType: string
  printSpec: string
  cached: boolean
  cachedAt: number
  cacheExpiresAt: number
}

export interface FolderListing {
  folders: string[]
  truncated: boolean
}

export interface StoredObject {
  key: string
  name: string
  size: number
}

export interface ObjectListing {
  folder: string
  objects: StoredObject[]
  truncated: boolean
}

export interface PrintSettingsResponse {
  folder: string
  selectType: string
  printSpec: string
  cacheInvalidated?: boolean
}
