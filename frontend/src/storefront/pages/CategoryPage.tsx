import { useEffect, useState } from 'preact/hooks'

import { ApiError, api } from '../../shared/api'
import type { CategoryPageData } from '../../shared/types'
import { Skeleton } from '../components/Skeleton'
import { ProductGrid } from '../features/catalogue/ProductGrid'
import { ProductGridSkeleton } from '../features/catalogue/ProductGridSkeleton'
import '../styles/shop.css'

/**
 * One category, or several at once.
 *
 * The slugs arrive exactly as they appear in the URL — `a,b` for either,
 * `a+b` for both — and are handed to the API unparsed. Splitting them here as
 * well would be a second implementation of the same rule, and the two would
 * eventually disagree about what a plus means.
 */
export function CategoryPage({ filter }: { filter: string }) {
  const [page, setPage] = useState<CategoryPageData | null>(null)
  const [missing, setMissing] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    api<CategoryPageData>(`/api/categories/${filter}`)
      .then((data) => {
        setPage(data)
        document.title = `${data.title} | Luma Studio`
      })
      .catch((error) => {
        if (error instanceof ApiError && error.status === 404) setMissing(true)
        else setFailed(true)
      })
  }, [filter])

  if (missing) {
    return (
      <main class="shop">
        <p class="empty">找不到這個分類。</p>
        <p class="empty">
          <a class="inline-action" href="/shop">回到商品列表</a>
        </p>
      </main>
    )
  }

  if (failed) return <main class="shop"><p class="empty">分類載入失敗，請稍後再試一次。</p></main>
  if (page === null) return (
    <main class="shop">
      <Skeleton class="page-title" />
      <ProductGridSkeleton count={4} />
    </main>
  )

  return (
    <main class="shop">
      <h1 class="shop-title">{page.title}</h1>

      {page.description && <p class="category-blurb">{page.description}</p>}

      {page.products.length === 0 ? (
        // Not a 404: the category exists, and saying "nothing here yet" is
        // the truth. A 404 would read as though the link were broken.
        <p class="empty">這個分類還沒有商品。</p>
      ) : (
        <ProductGrid products={page.products} />
      )}
    </main>
  )
}
