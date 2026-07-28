/**
 * How a moment is written, in one place.
 *
 * There were five of these under three names. Worse, `when()` in
 * CustomersPage printed a date and `when()` in OrdersAdminPage printed a date
 * and a time — the same name for different output, in two files somebody
 * reads side by side.
 *
 * Everything stored is a Unix timestamp in seconds, so that is what these
 * take. The locale is fixed rather than read from the browser: the shop is in
 * Taiwan, the owner reads Taiwanese dates, and a back office that reformats
 * itself on somebody else's laptop is one more thing to distrust.
 */

const LOCALE = 'zh-TW'

/** A day, for lists where the hour does not help. */
export function dateOnly(seconds: number): string {
  return new Date(seconds * 1000).toLocaleDateString(LOCALE, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
}

/** A day and a time, for anything a customer might ring up about. */
export function dateTime(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString(LOCALE, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}
