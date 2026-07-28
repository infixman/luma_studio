import type { BlockConfig, BlockType } from '../../shared/types'

/**
 * Carrying one configured block from one page to another.
 *
 * localStorage rather than a piece of component state, because the other page
 * is the whole point: opening it is a full navigation, so anything held in
 * memory is gone before the paste. A copy that only worked inside one page
 * would be duplicate with extra steps.
 *
 * What travels is the type and the config — the two things that make a block.
 * Not the id and not the position: a paste creates a new block, it does not
 * move the one that was copied. The original stays where it is, which is why
 * this is a copy and not a cut.
 */

const KEY = 'luma.block-clipboard'

/** Bumped when the stored shape changes, so an old entry is ignored rather than misread. */
const VERSION = 1

export interface CopiedBlock {
  type: BlockType
  config: BlockConfig
}

export function serialiseBlock(block: CopiedBlock): string {
  return JSON.stringify({ v: VERSION, type: block.type, config: block.config })
}

/**
 * Reads a copied block back, or nothing at all.
 *
 * `known` is the list of types this build can edit and render, and a type
 * outside it is refused. That is the case worth having: the clipboard outlives
 * a deploy, and a block copied from a newer version would paste into a page
 * with no editor to open it and no renderer to draw it — a row that does
 * nothing, holding content that never appears. Better to decline the paste
 * than to create that.
 *
 * Everything else that can be wrong here is refused the same way, and for the
 * same reason: whatever is under this key was written by some other version of
 * us, or by a person with a devtools console open, and neither is a promise.
 */
export function parseCopiedBlock(raw: string | null, known: readonly string[]): CopiedBlock | null {
  if (!raw) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const entry = parsed as { v?: unknown; type?: unknown; config?: unknown }

  if (entry.v !== VERSION) return null
  if (typeof entry.type !== 'string' || !known.includes(entry.type)) return null
  // A config has to be an object because that is what every editor is handed;
  // an array or a string would reach the editor as a shape it destructures.
  if (!entry.config || typeof entry.config !== 'object' || Array.isArray(entry.config)) return null

  return { type: entry.type as BlockType, config: entry.config as BlockConfig }
}

/* Storage itself can throw — Safari's private mode does — and a clipboard is
   not worth taking the editor down for. Both sides answer "no" instead. */

export function writeCopiedBlock(block: CopiedBlock): boolean {
  try {
    localStorage.setItem(KEY, serialiseBlock(block))
    return true
  } catch {
    return false
  }
}

export function readCopiedBlock(known: readonly string[]): CopiedBlock | null {
  try {
    return parseCopiedBlock(localStorage.getItem(KEY), known)
  } catch {
    return null
  }
}

/** Exported so a `storage` event can tell whether it was this key that moved. */
export const CLIPBOARD_KEY = KEY
