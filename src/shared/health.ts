import type { UsageWindow } from './types'

export const percentLeft = (w: UsageWindow): number =>
  Math.min(100, Math.max(0, 100 - w.usedPercent))

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** Length of a usage window's cycle, read from its label ("5h", "Weekly", …). */
export function cycleMs(label: string): number | null {
  const hours = label.match(/^(\d+)\s*h/i)
  if (hours) return Number(hours[1]) * HOUR
  const lower = label.toLowerCase()
  if (lower.includes('day')) return DAY
  if (lower.includes('week')) return 7 * DAY
  if (lower.includes('month')) return 30 * DAY
  return null
}

/**
 * Where an even burn would have you: the share of the window still to come.
 *
 * This is the only fair yardstick. 37% left is comfortable with a day to go and
 * alarming with six days to go, so judging the number alone paints both the
 * same. Null when the window carries no clock to measure against.
 */
export function onPaceLeft(w: UsageWindow, now: number): number | null {
  const period = w.periodMs ?? cycleMs(w.label)
  if (!period || !w.resetsAt) return null
  const remaining = (w.resetsAt - now) / period
  return Math.min(100, Math.max(0, remaining * 100))
}

export type Health = 'good' | 'warning' | 'critical'

/**
 * Health of a window, judged against its own clock rather than a flat cutoff.
 * Falls back to plain levels when there is no reset time to pace against.
 */
export function healthOf(w: UsageWindow, now: number): Health {
  const left = percentLeft(w)
  // Nearly empty is bad news whatever the clock says.
  if (left <= 10) return 'critical'
  const budget = onPaceLeft(w, now)
  if (budget === null) return left <= 30 ? 'warning' : 'good'
  // Ahead of an even burn once the window is nearly over is not a warning.
  if (budget <= 5) return 'good'
  const ratio = left / budget
  if (ratio >= 0.95) return 'good'
  return ratio >= 0.7 ? 'warning' : 'critical'
}
