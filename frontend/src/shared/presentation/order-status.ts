import type { OrderStatus } from '../types'

/** The concise label used wherever an order status is presented. */
export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  pending: '等待付款',
  paid: '已付款',
  shipped: '已出貨',
  completed: '已完成',
  cancelled: '已取消',
  expired: '已逾期',
}
