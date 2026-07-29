import { describe, expect, it } from 'vitest'

import { CONTACT_LABELS, contactHref } from './Blocks'
import { blockSummary, emptyConfig } from '../../admin/features/pages/blocks/BlockEditor'
import type { ContactConfig, ShopBlockConfig } from '../types'

/**
 * The decisions inside the block components that are not the drawing itself.
 *
 * `contactHref` is the one with something at stake: it builds a URL out of
 * something the owner typed, and the whole rule of this codebase is that what
 * the owner types never becomes a scheme, a style or a tag.
 */

describe('contactHref', () => {
  it('writes the scheme itself rather than taking one from the value', () => {
    // The point: whatever is in the field, the result starts with mailto:.
    // A value that looks like a scheme is treated as the address it is not.
    expect(contactHref({ kind: 'email', value: 'javascript:alert(1)' })).toBe('mailto:javascript:alert(1)')
    expect(contactHref({ kind: 'note', value: 'javascript:alert(1)' })).toBeNull()
  })

  it('links an email address', () => {
    expect(contactHref({ kind: 'email', value: 'shop@luma-studio.tw' })).toBe('mailto:shop@luma-studio.tw')
  })

  it('strips a phone number down to what a dialler can use', () => {
    // Spaces and dashes are how a number is written for a person to read.
    expect(contactHref({ kind: 'phone', value: '04-2222 3333' })).toBe('tel:0422223333')
    expect(contactHref({ kind: 'phone', value: '+886 4 2222 3333' })).toBe('tel:+886422223333')
  })

  it('leaves the kinds that are only worth reading unlinked', () => {
    expect(contactHref({ kind: 'address', value: '台中市西區' })).toBeNull()
    expect(contactHref({ kind: 'hours', value: '週三至週日 13:00–19:00' })).toBeNull()
  })

  it('does not link a value with nothing dialable in it', () => {
    expect(contactHref({ kind: 'phone', value: '打給我' })).toBeNull()
    expect(contactHref({ kind: 'email', value: '   ' })).toBeNull()
  })

  it('has a label for every kind it can be given', () => {
    // A kind with no label would render an empty heading over a real value.
    const kinds = ['email', 'phone', 'address', 'hours', 'note'] as const
    for (const kind of kinds) expect(CONTACT_LABELS[kind]).toBeTruthy()
  })
})

describe('what a new block starts as', () => {
  it('gives a shop block the plain grid and no labels over the artwork', () => {
    // Both defaults are decisions, not omissions: featured and overlaid are
    // things the owner turns on after looking at the work in question.
    const config = emptyConfig('shop') as ShopBlockConfig
    expect(config.layout).toBe('grid')
    expect(config.overlayLabels).toBe(false)
  })

  it('gives a contact block details on the left beside a picture', () => {
    const config = emptyConfig('contact') as ContactConfig
    expect(config.aside).toBe('image')
    expect(config.detailsSide).toBe('left')
    expect(config.details).toEqual([])
  })

  it('carries no field a form would need', () => {
    // There is no endpoint and the CSP is form-action 'none'. A config that
    // half-describes a form is how one gets built by accident.
    expect(Object.keys(emptyConfig('contact'))).toEqual([
      'heading',
      'details',
      'aside',
      'mediaId',
      'body',
      'detailsSide',
    ])
  })
})

describe('the line a collapsed block shows', () => {
  it('names the featured layout, because it is the one that is not ordinary', () => {
    const config = { ...(emptyConfig('shop') as ShopBlockConfig), layout: 'featured' as const, slugs: ['a', 'b'] }
    expect(blockSummary('shop', config)).toContain('精選')
    expect(blockSummary('shop', emptyConfig('shop'))).not.toContain('精選')
  })

  it('falls back from a heading to a count, and says so when there is neither', () => {
    const empty = emptyConfig('contact') as ContactConfig
    expect(blockSummary('contact', empty)).toBe('（還沒有聯絡方式）')
    expect(blockSummary('contact', { ...empty, details: [{ kind: 'email', value: 'x@y.tw' }] })).toBe('1 筆聯絡方式')
    expect(blockSummary('contact', { ...empty, heading: '來找我們' })).toBe('來找我們')
  })
})
