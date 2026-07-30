import { statSync } from 'node:fs'
import { basename, extname } from 'node:path'

import type { Progress, UploadRequest } from '../shared/upload'
import { discard, transcode } from './transcoder'
import { upload, type OnProgress } from './uploader'

/**
 * One job, from a dropped file to a registered video.
 *
 * Two entrances on purpose. An MP4 is transcoded and then uploaded; a folder of
 * finished output goes straight to uploading. The second is how the upload path
 * was proven before a transcoder existed, and it stays the way to re-send an
 * encode without spending an hour making it again.
 */

export async function ingest(
  request: UploadRequest,
  base: string,
  onProgress: OnProgress,
): Promise<Progress> {
  if (request.folder) {
    return upload({ ...request, folder: request.folder }, onProgress)
  }
  if (!request.source) {
    throw new Error('沒有指定要上傳的檔案或資料夾')
  }

  const encoded = await transcode(request.source, base, (step) => {
    // Folded into the same progress shape the interface already reads. There is
    // nothing to count during a transcode, so `fraction` carries it and
    // `uploaded`/`total` stay at zero rather than pretending.
    onProgress({
      phase: step.phase,
      uploaded: 0,
      total: 0,
      fraction: step.fraction,
      rung: step.rung,
      message: step.message,
    })
  })

  const result = await upload(
    {
      folder: encoded.folder,
      title: request.title || basename(request.source, extname(request.source)),
      durationSeconds: encoded.probed.durationSeconds || null,
      width: encoded.probed.width,
      height: encoded.probed.height,
      // The size of the file that was dropped in, not of what came out of the
      // encoder. The server divides this into multipart parts, so the encode
      // total here is an upload that fails partway through.
      sourceBytes: statSync(request.source).size,
      // The file itself goes up too, because a ladder cannot be rebuilt from a
      // ladder: adding a rung, fixing a bad encode or replacing an object R2
      // lost all start from the original.
      sourcePath: request.source,
    },
    onProgress,
  )

  // Only once the server has confirmed every object. An encode that failed to
  // upload is worth keeping: re-uploading is minutes, re-encoding is an hour.
  if (result.phase === 'done') discard(encoded.folder)
  return result
}
