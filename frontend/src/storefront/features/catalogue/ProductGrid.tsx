import type { PublicProductCard } from '../../../shared/types'
import { ProductCard } from './ProductCard'

export function ProductGrid({ products }: { products: PublicProductCard[] }) {
  return (
    <ul class="product-grid">
      {products.map((card) => <ProductCard key={card.slug} card={card} href={`/shop/${encodeURIComponent(card.slug)}`} />)}
    </ul>
  )
}
