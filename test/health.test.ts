import { describe, expect, it } from 'vitest'
import { healthOf, onPaceLeft, percentLeft } from '../src/shared/health'

const H = 3_600_000
describe('health', () => {
  it('percentLeft inverts usedPercent and clamps', () => {
    expect(percentLeft({ label: '5h', usedPercent: 30 })).toBe(70)
    expect(percentLeft({ label: '5h', usedPercent: 130 })).toBe(0)
  })
  it('onPaceLeft is the share of the window still ahead', () => {
    const now = Date.now()
    expect(onPaceLeft({ label: '5h', usedPercent: 0, periodMs: 5 * H, resetsAt: now + 2.5 * H }, now)).toBe(50)
    expect(onPaceLeft({ label: '5h', usedPercent: 0 }, now)).toBeNull()
  })
  it('healthOf grades against the clock', () => {
    const now = Date.now()
    expect(healthOf({ label: '5h', usedPercent: 97 }, now)).toBe('critical')
    expect(healthOf({ label: '5h', usedPercent: 10, periodMs: 5 * H, resetsAt: now + 4 * H }, now)).toBe('good')
  })
})
