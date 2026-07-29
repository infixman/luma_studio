import { Skeleton } from '../../components/Skeleton'

export function ProductGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <ul class="product-grid" aria-label="商品載入中" aria-busy="true">
      {Array.from({ length: count }, (_, index) => (
        <li key={index} class="card">
          <Skeleton class="cover" />
          <Skeleton class="line title" />
          <Skeleton class="line price" />
        </li>
      ))}
    </ul>
  )
}
