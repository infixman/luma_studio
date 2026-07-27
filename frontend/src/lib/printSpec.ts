/** Mapping between the four setting buttons and ibon's SelectType code. */

export type Paper = 'A4' | 'A3' | '4x6' | '4x6sticker'
export type ColorMode = 'mono' | 'color'
export type Sides = 'single' | 'double'
export type PaperType = 'common' | 'special'

export interface PrintChoice {
  paper: Paper
  color: ColorMode
  sides: Sides
  paperType: PaperType
}

export const defaultPrintChoice: PrintChoice = { paper: 'A4', color: 'color', sides: 'single', paperType: 'common' }

/** Photo paper is always colour, single sided and plain in ibon's model. */
export function isPhotoPaper(choice: PrintChoice): boolean {
  return choice.paper === '4x6' || choice.paper === '4x6sticker'
}

export function toSelectType(choice: PrintChoice): string {
  if (choice.paper === '4x6') return 'F4X6N1'
  if (choice.paper === '4x6sticker') return 'F4X6S1'
  return `F${choice.paper}${choice.color === 'color' ? 'C' : 'B'}${choice.paperType === 'common' ? 'N' : 'S'}${choice.sides === 'single' ? '1' : '2'}`
}

export function fromSelectType(selectType: string): PrintChoice {
  if (selectType === 'F4X6N1') return { paper: '4x6', color: 'color', sides: 'single', paperType: 'common' }
  if (selectType === 'F4X6S1') return { paper: '4x6sticker', color: 'color', sides: 'single', paperType: 'common' }
  const match = /^F(A[34])(C|B)(N|S)(1|2)$/.exec(selectType)
  if (!match) return { ...defaultPrintChoice }
  return {
    paper: match[1] as Paper,
    color: match[2] === 'C' ? 'color' : 'mono',
    paperType: match[3] === 'N' ? 'common' : 'special',
    sides: match[4] === '1' ? 'single' : 'double',
  }
}

/** Normalise a change so photo paper never keeps an impossible combination. */
export function applyChoice(choice: PrintChoice, key: keyof PrintChoice, value: string): PrintChoice {
  const next = { ...choice, [key]: value } as PrintChoice
  if (isPhotoPaper(next)) {
    next.color = 'color'
    next.sides = 'single'
    next.paperType = 'common'
  }
  return next
}

interface SettingGroup {
  legend: string
  key: keyof PrintChoice
  options: { value: string; label: string }[]
}

export const settingGroups: SettingGroup[] = [
  {
    legend: '紙張尺寸',
    key: 'paper',
    options: [
      { value: 'A4', label: 'A4' },
      { value: 'A3', label: 'A3' },
      { value: '4x6', label: '4x6' },
      { value: '4x6sticker', label: '4x6貼紙' },
    ],
  },
  {
    legend: '色彩模式',
    key: 'color',
    options: [
      { value: 'mono', label: '黑白' },
      { value: 'color', label: '彩色' },
    ],
  },
  {
    legend: '列印模式',
    key: 'sides',
    options: [
      { value: 'single', label: '單面列印' },
      { value: 'double', label: '雙面列印' },
    ],
  },
  {
    legend: '紙張種類',
    key: 'paperType',
    options: [
      { value: 'common', label: '一般用紙' },
      { value: 'special', label: '特殊用紙' },
    ],
  },
]

/** Photo paper locks every group except the paper size itself. */
export function isOptionDisabled(choice: PrintChoice, key: keyof PrintChoice, value: string): boolean {
  if (!isPhotoPaper(choice) || key === 'paper') return false
  const allowed = key === 'color' ? 'color' : key === 'sides' ? 'single' : 'common'
  return value !== allowed
}
