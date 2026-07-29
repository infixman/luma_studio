import { describe, expect, it } from 'vitest'

import { productReturnTarget } from './ProductPage'

describe('productReturnTarget', () => {
  it('returns to the page that embedded the shop row', () => {
    expect(productReturnTarget('?from=%2Fphysical-courses')).toEqual({
      href: '/physical-courses',
      label: '原本的頁面',
    })
  })

  it('keeps the catalogue as the fallback for direct product links', () => {
    expect(productReturnTarget('')).toEqual({ href: '/shop', label: '商品列表' })
  })

  it('does not accept a protocol-relative return target', () => {
    expect(productReturnTarget('?from=%2F%2Fevil.example')).toEqual({ href: '/shop', label: '商品列表' })
  })
})
