import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { app } from 'electron'

/**
 * What has already been uploaded, so an interrupted run resumes.
 *
 * Written after every object rather than after every batch. A batch is a hundred
 * files; losing one to a crash is the difference between carrying on and
 * starting a two-hour transfer again.
 *
 * Not encrypted, and nothing here needs to be: it is a list of object names and
 * an asset id, all of which the server already knows. The token is somewhere
 * else — see `store.ts`.
 */

export interface Record_ {
  assetId: string
  encodeVersion: number
  done: string[]
}

function folder(): string {
  const path = join(app.getPath('userData'), 'uploads')
  mkdirSync(path, { recursive: true })
  return path
}

function file(id: string): string {
  return join(folder(), `${id}.json`)
}

export function read(id: string): Record_ | null {
  try {
    const raw = JSON.parse(readFileSync(file(id), 'utf8')) as Partial<Record_>
    if (typeof raw.assetId !== 'string' || !raw.assetId) return null
    if (!Number.isInteger(raw.encodeVersion)) return null
    if (!Array.isArray(raw.done)) return null
    return {
      assetId: raw.assetId,
      encodeVersion: raw.encodeVersion as number,
      done: raw.done.filter((entry): entry is string => typeof entry === 'string'),
    }
  } catch {
    // No file, a half-written one, or one from an older shape. Every case
    // recovers by uploading everything again, which is slow rather than wrong.
    return null
  }
}

export function write(id: string, record: Record_): void {
  try {
    writeFileSync(file(id), JSON.stringify(record))
  } catch {
    // Failing to remember progress is not failing to upload. The run continues;
    // only a resume would be slower.
  }
}

export function clear(id: string): void {
  try {
    rmSync(file(id), { force: true })
  } catch {
    // Already gone.
  }
}
