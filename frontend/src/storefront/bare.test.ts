import { describe, expect, it } from 'vitest'

import { isBare } from './app'

describe('which pages wear no site chrome', () => {
  it('keeps the navigation out of the way while someone is paying', () => {
    expect(isBare('/checkout')).toBe(true)
  })

  it('dresses the order pages: looking up a past order is browsing', () => {
    expect(isBare('/orders')).toBe(false)
    expect(isBare('/orders/LS20260728abcdefg')).toBe(false)
  })

  it('strips the preview, because it is the one path that may be framed', () => {
    // The framing relaxation is granted on the promise that this page offers
    // nothing worth clicking. The header carries a cart and a login link.
    expect(isBare('/__preview/abcdefghijklmnopqrstuvwx')).toBe(true)
  })

  it('leaves the pages that stand on their own alone', () => {
    // Both already carry the studio's mark. The site header would put a
    // second logo above the first, and a shopping cart in front of someone
    // standing at an ibon machine.
    expect(isBare('/card')).toBe(true)
    expect(isBare('/ibon_print/20260721_soda')).toBe(true)
  })

  it('dresses everything else', () => {
    expect(isBare('/')).toBe(false)
    expect(isBare('/shop')).toBe(false)
    expect(isBare('/shop/kit')).toBe(false)
    expect(isBare('/cart')).toBe(false)
    expect(isBare('/about')).toBe(false)
  })

  it('does not mistake a page whose path merely starts the same way', () => {
    expect(isBare('/cards')).toBe(false)
    expect(isBare('/ibon_printer')).toBe(false)
    expect(isBare('/__previewing')).toBe(false)
  })
})
