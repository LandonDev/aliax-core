import { describe, expect, it } from 'vitest'
import { parseClaudeUsage } from '../src/adapters/claude'
import { retryAfterMs } from '../src/adapters/types'

describe('parseClaudeUsage', () => {
  it('reads the limits[] shape including a scoped Fable weekly', () => {
    const windows = parseClaudeUsage({
      limits: [
        { kind: 'session', group: 'session', percent: 12, resets_at: '2026-09-15T10:00:00Z' },
        { kind: 'weekly_all', group: 'weekly', percent: 40, resets_at: '2026-09-20T00:00:00Z' },
        { kind: 'weekly_scoped', group: 'weekly', percent: 63, scope: { model: { display_name: 'Fable' } } },
        { kind: 'weekly_scoped', group: 'weekly', percent: 0, scope: { model: { display_name: 'Opus' } } }
      ]
    })
    expect(windows.map((w) => [w.label, w.usedPercent])).toEqual([
      ['5h', 12],
      ['Weekly', 40],
      ['Fable', 63]
    ])
    expect(windows[0].periodMs).toBe(5 * 3_600_000)
    expect(windows[1].resetsAt).toBe(Date.parse('2026-09-20T00:00:00Z'))
  })
  it('falls back to named keys for older accounts', () => {
    const windows = parseClaudeUsage({
      five_hour: { utilization: 5, resets_at: 1_800_000_000 },
      seven_day: { utilization: 0 },
      seven_day_fable: { utilization: 0 }
    })
    expect(windows.map((w) => w.label)).toEqual(['5h', 'week'])
    expect(windows[0].resetsAt).toBe(1_800_000_000_000)
  })
})

describe('retryAfterMs', () => {
  const res = (v: string | null) => ({ headers: { get: () => v } })
  it('handles seconds, dates and absence', () => {
    expect(retryAfterMs(res('30'))).toBe(30_000)
    expect(retryAfterMs(res(null))).toBeUndefined()
    const later = new Date(Date.now() + 60_000).toUTCString()
    const ms = retryAfterMs(res(later))!
    expect(ms).toBeGreaterThan(50_000)
    expect(ms).toBeLessThanOrEqual(60_000)
  })
})
