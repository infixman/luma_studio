import type { BadgeTone } from '../../components/ui'
import type { OrderStatus } from '../../../shared/types'

/** Badge colour is an admin UI concern, unlike the shared status wording. */
export const ORDER_STATUS_TONES: Record<OrderStatus, BadgeTone> = {
  pending: 'warning',
  paid: 'info',
  shipped: 'primary',
  completed: 'success',
  cancelled: 'danger',
  expired: 'neutral',
}
