import type { PageStatus } from '../types'

/** What the shop looks like right now, in one answer. */
export interface DashboardSummary {
  orders: {
    pending: number
    paid: number
    shipped: number
    completed: number
    waiting: number
  }
  revenue: { orders: number; total: number }
  lowStock: { id: string; productTitle: string; variantTitle: string; slug: string; stock: number }[]
  recentPages: { id: string; title: string; path: string; status: PageStatus; updatedAt: number }[]
  lowStockAt: number
}
