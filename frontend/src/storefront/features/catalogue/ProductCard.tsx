import { apiUrl } from '../../../shared/api'
import { priceLabel } from '../../../shared/money'
import type { PublicProductCard } from '../../../shared/types'

export function ProductCard({ card }: { card: PublicProductCard }) {
  return (
    <li class={card.inStock ? 'card' : 'card sold-out'}>
      <a href={`/shop/${encodeURIComponent(card.slug)}`}>
        <div class="cover">
          {card.coverPath ? <img src={apiUrl(card.coverPath)} alt="" loading="lazy" /> : <span />}
          {!card.inStock && <span class="ribbon">售完</span>}
        </div>
        <h2>{card.title}</h2>
        <p class="price">{priceLabel(card.priceFrom, card.priceTo)}</p>
      </a>
    </li>
  )
}
