import { describe, expect, it } from 'vitest'

import {
  applyChoice,
  defaultPrintChoice,
  fromSelectType,
  isOptionDisabled,
  isPhotoPaper,
  settingGroups,
  toSelectType,
  type PrintChoice,
} from './printSpec'

/** Every combination the four setting groups can produce. */
function allChoices(): PrintChoice[] {
  const choices: PrintChoice[] = []
  for (const paper of ['A4', 'A3', '4x6', '4x6sticker'] as const) {
    for (const color of ['mono', 'color'] as const) {
      for (const sides of ['single', 'double'] as const) {
        for (const paperType of ['common', 'special'] as const) {
          choices.push({ paper, color, sides, paperType })
        }
      }
    }
  }
  return choices
}

describe('toSelectType', () => {
  it('builds the codes ibon expects', () => {
    expect(toSelectType({ paper: 'A4', color: 'color', sides: 'single', paperType: 'common' })).toBe('FA4CN1')
    expect(toSelectType({ paper: 'A3', color: 'mono', sides: 'double', paperType: 'special' })).toBe('FA3BS2')
  })

  it('collapses photo paper to its single code', () => {
    // ibon has one code per photo paper; the other three settings cannot vary.
    expect(toSelectType({ paper: '4x6', color: 'mono', sides: 'double', paperType: 'special' })).toBe('F4X6N1')
    expect(toSelectType({ paper: '4x6sticker', color: 'mono', sides: 'double', paperType: 'special' })).toBe('F4X6S1')
  })
})

describe('fromSelectType', () => {
  it('reverses a code back into settings', () => {
    expect(fromSelectType('FA3BS2')).toEqual({ paper: 'A3', color: 'mono', sides: 'double', paperType: 'special' })
  })

  it('falls back to the default for anything unrecognised', () => {
    // The database default from migration 0003 arrives here.
    expect(fromSelectType('FNOMAL')).toEqual(defaultPrintChoice)
    expect(fromSelectType('')).toEqual(defaultPrintChoice)
  })

  it('round-trips every code a normalised choice can produce', () => {
    for (const choice of allChoices()) {
      const normalised = isPhotoPaper(choice)
        ? { ...choice, color: 'color' as const, sides: 'single' as const, paperType: 'common' as const }
        : choice
      expect(fromSelectType(toSelectType(normalised))).toEqual(normalised)
    }
  })
})

describe('applyChoice', () => {
  it('changes only the setting that was clicked', () => {
    const next = applyChoice(defaultPrintChoice, 'color', 'mono')
    expect(next).toEqual({ ...defaultPrintChoice, color: 'mono' })
  })

  it('normalises the impossible combinations photo paper cannot express', () => {
    const mixed: PrintChoice = { paper: 'A4', color: 'mono', sides: 'double', paperType: 'special' }
    expect(applyChoice(mixed, 'paper', '4x6')).toEqual({
      paper: '4x6',
      color: 'color',
      sides: 'single',
      paperType: 'common',
    })
  })

  it('leaves the other settings alone for ordinary paper', () => {
    const photo: PrintChoice = { paper: '4x6', color: 'color', sides: 'single', paperType: 'common' }
    expect(applyChoice(photo, 'paper', 'A3')).toEqual({ ...photo, paper: 'A3' })
  })
})

describe('isOptionDisabled', () => {
  it('locks nothing for ordinary paper', () => {
    for (const group of settingGroups) {
      for (const option of group.options) {
        expect(isOptionDisabled(defaultPrintChoice, group.key, option.value)).toBe(false)
      }
    }
  })

  it('locks every group except paper size for photo paper', () => {
    const photo: PrintChoice = { paper: '4x6', color: 'color', sides: 'single', paperType: 'common' }
    const disabled = settingGroups.flatMap((group) =>
      group.options
        .filter((option) => isOptionDisabled(photo, group.key, option.value))
        .map((option) => `${group.key}:${option.value}`),
    )
    expect(disabled).toEqual(['color:mono', 'sides:double', 'paperType:special'])
  })

  it('never disables the option that is currently selected', () => {
    for (const choice of allChoices()) {
      const normalised = applyChoice(choice, 'paper', choice.paper)
      for (const group of settingGroups) {
        expect(isOptionDisabled(normalised, group.key, normalised[group.key])).toBe(false)
      }
    }
  })
})
