/**
 * How a price is written, in one place.
 *
 * There were four of these. Two storefront pages said `NT$300 起`, the shop
 * block said `NT$300–500`, and the product page said `NT$300 – NT$500` — so
 * the same product carried three different prices depending on which page you
 * were looking at, and a shop block on the home page disagreed with /shop.
 *
 * They also disagreed about missing data: one treated `priceTo === null` as
 * unsellable, another rendered a price anyway.
 *
 * `起` rather than a range: it is what the storefront already said in the two
 * places a customer is most likely to see first, and it is the honest reading
 * of a product whose variants cost different amounts.
 */
export function priceLabel(priceFrom: number | null, priceTo: number | null): string {
  if (priceFrom === null) return '暫不販售'
  if (priceTo === null || priceFrom === priceTo) return money(priceFrom)
  return `${money(priceFrom)} 起`
}

/**
 * One amount. Thousands are grouped, because 12480 and 1248 are one glance
 * apart otherwise and this is money.
 */
export function money(amount: number): string {
  return `NT$${amount.toLocaleString('zh-TW')}`
}
