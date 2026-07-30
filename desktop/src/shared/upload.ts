/**
 * The shapes the interface and the uploader agree on.
 *
 * In `shared` rather than beside the uploader because all three sides refer to
 * them, and a renderer importing a type out of `main/` reads as though it could
 * import the rest of it.
 */

export interface ScannedFolder {
  folder: string
  /** Relative POSIX paths that belong to an encode, in the order to upload them. */
  objects: string[]
  /** Anything else found, so the interface can say what is being ignored. */
  unexpected: string[]
  totalBytes: number
}

export type UploadPhase =
  | 'scanning'
  | 'creating'
  | 'uploading'
  | 'registering'
  | 'done'
  | 'failed'

export interface Progress {
  phase: UploadPhase
  assetId?: string
  uploaded: number
  total: number
  message?: string
  /** On `failed` after registration: every object the server could not find. */
  missing?: string[]
}

export interface UploadRequest {
  folder: string
  title: string
  durationSeconds?: number | null
  width?: number | null
  height?: number | null
}

export type UploadResult =
  | { ok: true; result: Progress }
  | { ok: false; message: string; httpStatus: number | null }
