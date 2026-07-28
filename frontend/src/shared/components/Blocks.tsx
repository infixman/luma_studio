import { renderMarkdown } from '../markdown'
import type { PageBlock } from '../types'
import './blocks.css'

/**
 * Renders a page's blocks. Shared deliberately.
 *
 * The storefront uses this to show a published page; the back office uses it
 * to preview a draft. That is the whole reason drafts never need to be
 * fetchable from the public API — what the owner sees in the editor is what
 * a visitor will see, because it is the same component.
 *
 * Adding a block type means adding a case here and a validator in
 * backend/src/pages.py. Nothing else in the page machinery changes.
 */
export function Blocks({ blocks }: { blocks: PageBlock[] }) {
  return (
    <>
      {blocks.map((block) => (
        <Block key={block.id} block={block} />
      ))}
    </>
  )
}

function Block({ block }: { block: PageBlock }) {
  if (block.type === 'text') {
    // The HTML is produced by renderMarkdown, which escapes its input before
    // applying any rule — the only tags here are ones that file wrote.
    return (
      <section
        class="block block-text"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(block.config.body ?? '') }}
      />
    )
  }

  // A type the API validated but this build has no case for. Rendering
  // nothing is right; the editor is where an unknown block gets dealt with.
  return null
}
