import { RadioGroup } from './ui'
import type { BioLinkFont, BioLinkShape, BioLinkStyle, BioLinkTheme } from '../../shared/types'

/**
 * Appearance is chosen from named options, never typed.
 *
 * The owner writes no CSS, so every combination on offer has to be one that
 * works: the palettes are contrast-checked in bio-link.theme.test.ts, and
 * nothing here can produce a colour that is not on this list.
 */
const themes: { value: BioLinkTheme; label: string }[] = [
  { value: 'warm', label: '暖白' },
  { value: 'ink', label: '純白' },
  { value: 'forest', label: '森綠' },
  { value: 'sand', label: '沙棕' },
  { value: 'night', label: '夜色' },
]

const shapes: { value: BioLinkShape; label: string }[] = [
  { value: 'rounded', label: '圓角' },
  { value: 'pill', label: '膠囊' },
  { value: 'square', label: '方角' },
]

const fonts: { value: BioLinkFont; label: string }[] = [
  { value: 'sans', label: '黑體' },
  { value: 'serif', label: '明體' },
]

interface Props {
  style: BioLinkStyle
  avatarPath: string | null
  displayName: string
  busy: boolean
  onChange: (patch: Partial<BioLinkStyle>) => void
}

export function BioLinkAppearance({ style, avatarPath, displayName, busy, onChange }: Props) {
  /* Radios, not buttons. They were `<button class="choice">`, leaning on a
     class the ibon page owned; when that page moved onto the component set
     the class went with it and all five palettes rendered as identical
     filled buttons — no gap, and no way to see which one was picked. Being
     one-of-a-set is what a radio group is, so the selected state, the
     spacing and the arrow keys all arrive with it. */
  const group = <T extends string>(
    legend: string,
    options: { value: T; label: string }[],
    current: T,
    key: keyof BioLinkStyle,
  ) => (
    <RadioGroup
      legend={legend}
      inline
      value={current}
      options={options.map((option) => ({ ...option, disabled: busy }))}
      onChange={(value) => onChange({ [key]: value } as Partial<BioLinkStyle>)}
    />
  )

  return (
    <section class="bio-appearance">
      <div class="bio-appearance-controls">
        {group('配色', themes, style.theme, 'theme')}
        {group('按鈕形狀', shapes, style.buttonShape, 'buttonShape')}
        {group('字體', fonts, style.fontStyle, 'fontStyle')}
      </div>

      {/* The real palettes, not a copy: these rules come from bio-link.css. */}
      <div
        class="bio-preview"
        data-theme={style.theme}
        data-shape={style.buttonShape}
        data-font={style.fontStyle}
        aria-label="公開頁預覽"
      >
        <div class="bio-preview-page">
          {avatarPath ? (
            <img class="bio-preview-avatar" src={avatarPath} alt="" />
          ) : (
            <div class="bio-preview-avatar" aria-hidden="true" />
          )}
          <p class="bio-preview-name">{displayName || '苒光繪誌'}</p>
          <p class="bio-preview-bio">台中・桃園開課</p>
          <span class="bio-preview-button">作品集</span>
          <span class="bio-preview-button">預約課程</span>
          <div class="bio-preview-socials">
            <span />
            <span />
            <span />
          </div>
        </div>
      </div>
    </section>
  )
}
