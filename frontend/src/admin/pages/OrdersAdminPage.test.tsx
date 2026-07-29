// @vitest-environment happy-dom

/**
 * The shipping action on an order that may have nothing to ship.
 *
 * The server refuses to mark a digital-only order shipped, so this is about
 * not offering a button whose only outcome is an error. What the page does
 * when it cannot tell is the interesting part, and is pinned below.
 */

import { expect, test } from 'vitest'

import { shippableMoves } from './OrdersAdminPage'

const MOVES = [
  { action: 'shipped', label: '標記已出貨' },
  { action: 'cancelled', label: '取消訂單', danger: true },
]

test('an order with something to post offers the shipping action', () => {
  expect(shippableMoves(MOVES, true).map((move) => move.action)).toEqual(['shipped', 'cancelled'])
})

test('an order with nothing to post does not', () => {
  expect(shippableMoves(MOVES, false).map((move) => move.action)).toEqual(['cancelled'])
})

test('an order that cannot say keeps the action', () => {
  // Only reachable if the back office is newer than the API it is talking to,
  // which the admin-first deploy order makes a rollback rather than a normal
  // state. Hiding the button there would leave real parcels unshippable,
  // whereas showing it costs at most one 409 the server already returns.
  expect(shippableMoves(MOVES, undefined).map((move) => move.action)).toEqual(['shipped', 'cancelled'])
})
