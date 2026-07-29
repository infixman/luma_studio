import { describe, expect, it } from 'vitest'

import type { PublicProductDetail } from '../../shared/types'
import { initialOfferId, offerPurchaseState, productReturnTarget, showOfferChooser } from './ProductPage'

const singleOffer: PublicProductDetail = {
  slug: 'canvas-bag',
  title: 'Canvas bag',
  description: '',
  images: [],
  requiresOfferSelection: false,
  variants: [{ id: 'offer-1', title: null, price: 300, inStock: true, stockLeft: null }],
  categories: [],
}

describe('productReturnTarget', () => {
  it('returns to the page that embedded the shop row', () => {
    expect(productReturnTarget('?from=%2Fphysical-courses')).toEqual({
      href: '/physical-courses',
      label: '上一頁',
    })
  })

  it('keeps the catalogue as the fallback for direct product links', () => {
    expect(productReturnTarget('')).toEqual({ href: '/shop', label: '商品列表' })
  })

  it('does not accept a protocol-relative return target', () => {
    expect(productReturnTarget('?from=%2F%2Fevil.example')).toEqual({ href: '/shop', label: '商品列表' })
  })
})

describe('Offer selection', () => {
  it('automatically uses the only Offer and hides its chooser', () => {
    expect(initialOfferId(singleOffer)).toBe('offer-1')
    expect(showOfferChooser(singleOffer)).toBe(false)
  })

  it('keeps a multi-Offer product unselected until the visitor chooses', () => {
    const multiOffer = {
      ...singleOffer,
      requiresOfferSelection: true,
      variants: [
        { id: 'offer-1', title: '標準版', price: 300, inStock: true, stockLeft: null },
        { id: 'offer-2', title: '加大版', price: 500, inStock: true, stockLeft: null },
      ],
    }

    expect(initialOfferId(multiOffer)).toBeNull()
    expect(showOfferChooser(multiOffer)).toBe(true)
    expect(offerPurchaseState(multiOffer, null)).toBe('choose')
  })

  it('keeps a sold-out single Offer selected so the page can state it is sold out', () => {
    const soldOut = {
      ...singleOffer,
      variants: [{ id: 'offer-1', title: null, price: 300, inStock: false, stockLeft: null }],
    }

    expect(initialOfferId(soldOut)).toBe('offer-1')
    expect(showOfferChooser(soldOut)).toBe(false)
    expect(offerPurchaseState(soldOut, soldOut.variants[0]!)).toBe('soldout')
  })
})
