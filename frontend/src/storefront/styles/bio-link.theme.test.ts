import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * The palettes are checked by calculation, not by eye.
 *
 * The owner picks a theme by name and has no way to judge whether the result
 * is readable, so that judgement has to live here. This reads the stylesheet
 * itself rather than a copy of the values, so a palette cannot drift past the
 * check by being edited in one place only.
 */
// Read from disk rather than imported: under vitest a `?raw` import of a
// stylesheet still goes through the CSS pipeline and arrives empty.
const css = readFileSync(fileURLToPath(new URL('./bio-link.css', import.meta.url)), 'utf8')

type Palette = Record<string, string>

function declarations(block: string): Palette {
  const values: Palette = {}
  for (const [, key, value] of block.matchAll(/--bio-([a-z-]+):\s*([^;]+);/g)) {
    values[key!] = value!.trim()
  }
  return values
}

function palettes(): Record<string, Palette> {
  // The base block carries the default palette; each theme block overrides
  // part of it, exactly as the cascade does at runtime.
  const base = declarations(/:where\(body\.bio, \.bio-preview\)\s*\{([^}]*)\}/.exec(css)?.[1] ?? '')
  const found: Record<string, Palette> = { warm: base }
  for (const [, name, block] of css.matchAll(/\[data-theme="([a-z]+)"\]\s*\{([^}]*)\}/g)) {
    found[name!] = { ...base, ...declarations(block!) }
  }
  return found
}

function channel(value: number): number {
  const ratio = value / 255
  return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) throw new Error(`not a six-digit hex colour: ${hex}`)
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(match[1]!.slice(offset, offset + 2), 16))
  return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!)
}

/** WCAG 2.1 contrast ratio, 1 to 21. */
function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (lighter! + 0.05) / (darker! + 0.05)
}

const themes = palettes()
const names = Object.keys(themes)

describe('theme palettes', () => {
  it('lets a theme outweigh the default palette', () => {
    // The themes are plain attribute selectors, (0,1,0). Written as
    // `body.bio, .bio-preview` the defaults are (0,1,1) and win every
    // cascade, which shipped a page that ignored every appearance setting.
    // :where() zeroes them, so this is what makes the choices work.
    expect(css).toContain(':where(body.bio, .bio-preview) {')

    // Every block that sets a palette must be either the zeroed default or a
    // theme; anything else would sit between them in the cascade.
    for (const rule of css.split('}')) {
      const [selector, body] = rule.split('{')
      if (!body?.includes('--bio-page:')) continue
      const name = selector!.replace(/\/\*[\s\S]*?\*\//g, '').trim()
      expect(name === ':where(body.bio, .bio-preview)' || /^\[data-theme="[a-z]+"\]$/.test(name), name).toBe(true)
    }
  })

  it('finds every theme the backend offers', () => {
    // Mirrors the bio-link domain contract's theme set.
    expect(names.sort()).toEqual(['forest', 'ink', 'night', 'sand', 'warm'])
  })

  it.each(names)('%s defines a full palette', (name) => {
    for (const key of ['page', 'glow', 'surface', 'border', 'text', 'muted', 'accent']) {
      expect(themes[name]![key], `${name} is missing --bio-${key}`).toBeTruthy()
    }
  })

  describe.each(names)('%s', (name) => {
    const palette = themes[name]!

    it('body text on a card reaches AA', () => {
      // 4.5:1 is the WCAG AA threshold for text below 18pt.
      expect(contrast(palette.text!, palette.surface!)).toBeGreaterThanOrEqual(4.5)
    })

    it('body text on the page reaches AA', () => {
      expect(contrast(palette.text!, palette.page!)).toBeGreaterThanOrEqual(4.5)
    })

    it('secondary text reaches AA on both', () => {
      // The bio and event details use this, and they are the longest text
      // on the page — exactly what a weaker ratio hurts most.
      expect(contrast(palette.muted!, palette.surface!)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(palette.muted!, palette.page!)).toBeGreaterThanOrEqual(4.5)
    })

    it('text on the date badge reaches AA', () => {
      expect(contrast(palette.text!, palette.glow!)).toBeGreaterThanOrEqual(4.5)
    })

    it('a card is distinguishable from the page behind it', () => {
      const separation = contrast(palette.surface!, palette.page!)
      const borderVisible = contrast(palette.border!, palette.surface!)
      // Either the card reads as a different surface, or its border does the
      // work. A theme where neither holds has invisible buttons.
      expect(Math.max(separation, borderVisible)).toBeGreaterThan(1.15)
    })
  })
})
