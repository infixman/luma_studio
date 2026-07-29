import { useState } from 'preact/hooks'

import type { TextBlockConfig } from '../../shared/types'
import { RichTextEditor } from './RichTextEditor'

const INITIAL_CONTENT: TextBlockConfig = {
  format: 'html',
  body: [
    '<h2>HTML 編輯器預覽</h2>',
    '<p>游標移到不同字級的文字，工具列會同步更新。點進下方表格即可展開列、欄與表格屬性工具。</p>',
    '<p><span style="font-size:24px">這段是 24px 文字</span></p>',
    '<table style="width:100%;border-collapse:collapse" title="課程時段">',
    '<thead><tr><th>日期</th><th>主題</th><th>備註</th></tr></thead>',
    '<tbody><tr><td>8 / 12</td><td>基礎練習</td><td><br></td></tr><tr><td>8 / 19</td><td>作品討論</td><td><br></td></tr></tbody>',
    '</table>',
  ].join(''),
}

/** Local-only route for checking the editor without an administrative session. */
export function RichTextEditorPreview() {
  const [config, setConfig] = useState(INITIAL_CONTENT)

  return (
    <main class="rte-preview-page">
      <header class="rte-preview-head">
        <div>
          <p class="rte-preview-eyebrow">LOCAL PREVIEW</p>
          <h1>HTML 編輯器</h1>
          <p>此頁只會在開發模式提供，不會略過正式後台登入。</p>
        </div>
        <button type="button" class="rte-preview-reset" onClick={() => setConfig(INITIAL_CONTENT)}>重設範例內容</button>
      </header>
      <RichTextEditor config={config} onChange={setConfig} />
    </main>
  )
}
