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

/**
 * A scan answers rather than throws.
 *
 * An exception crossing IPC reaches the interface as `Error invoking remote
 * method 'upload:scan': Error: ENOTDIR: not a directory, scandir '...'` — the
 * channel name and the errno, and no sentence. A refusal is an ordinary outcome
 * of dropping the wrong thing, so it is a value like any other.
 */
export type ScanResult = { ok: true; scanned: ScannedFolder } | { ok: false; message: string }

/**
 * One list rather than two, because from the interface's point of view this is
 * one job with a bar in it. Dropping an MP4 runs the first five; dropping a
 * folder of finished output starts at `scanning`.
 */
export type UploadPhase =
  | 'preparing'
  | 'probing'
  | 'encoding'
  | 'poster'
  | 'writing'
  | 'scanning'
  | 'creating'
  // The original file, in parts. Its own phase because it is the longest single
  // transfer in the job and counting objects would say "1 of 1" for an hour.
  | 'source'
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
  /** Which rendition is encoding, during `encoding`. */
  rung?: string
  /** 0–1 during the transcode, where there is nothing to count. */
  fraction?: number
  /** On `failed` after registration: every object the server could not find. */
  missing?: string[]
}

/**
 * Either an MP4 to transcode or a folder of output already produced.
 *
 * Both, rather than one: the folder case is how uploading was proven before a
 * transcoder existed, and it stays the way to re-upload an encode without
 * spending an hour making it again.
 */
export interface UploadRequest {
  source?: string
  folder?: string
  title: string
  durationSeconds?: number | null
  width?: number | null
  height?: number | null
}

export type UploadResult =
  | { ok: true; result: Progress }
  | { ok: false; message: string; httpStatus: number | null }


/**
 * Which size the asset records.
 *
 * The source's, when the job started from a file. Two things read that column
 * and both are wrong if it holds the encode total: the library calls it
 * 原始檔容量, and the server divides it into multipart parts — so a tool cutting
 * the real file by a part size derived from a different number produces a part
 * the server refuses, partway through the upload.
 *
 * The folder-only entrance has no original to describe. The encode total is the
 * only size there is, and that path uploads no source.
 */
export function recordedByteSize(sourceBytes: number | null | undefined, encodeTotal: number): number {
  return typeof sourceBytes === 'number' && sourceBytes > 0 ? sourceBytes : encodeTotal
}
