import { apiUrl } from '../api'
import { priceLabel } from '../money'
import type { PublicProductCard } from '../types'
import './product-card.css'

/**
 * The one visual contract for a product wherever it is offered.
 *
 * A catalogue and a page-embedded shop decide only where the link returns
 * to. The picture, price, stock state and card treatment must stay identical
 * or the same product looks like it belongs to two different shops.
 */
export function ProductCard({ card, href }: { card: PublicProductCard; href: string }) {
  return (
    <li class={card.inStock ? 'product-card' : 'product-card sold-out'}>
      <a href={href}>
        <span class="product-card-cover">
          {card.coverPath ? <img src={apiUrl(card.coverPath)} alt="" loading="lazy" /> : <span />}
          {!card.inStock && <span class="product-card-ribbon">售完</span>}
        </span>
        <span class="product-card-details">
          <span class="product-card-title">{card.title}</span>
          <span class="product-card-price">{priceLabel(card.priceFrom, card.priceTo)}</span>
        </span>
      </a>
    </li>
  )
}
