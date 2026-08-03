/**
 * A position or a length, as a control bar says it.
 *
 * The hour appears only once there is one: `00:02:55` on a three-minute
 * lesson reads as a mistake, and `2:55` on a two-hour recording reads as a
 * different video.
 */
export function clock(seconds: number): string {
  // duration is NaN until the metadata arrives and Infinity for a live
  // stream. Both have to read as "not known yet" rather than as a time.
  if (!Number.isFinite(seconds)) return '--:--'

  const whole = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor((whole % 3600) / 60)
  const rest = whole % 60

  const pad = (value: number) => String(value).padStart(2, '0')

  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`
}
