import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as accounts from '../src/accounts'
import { codexSnapshotToWindows, parseUnifiedHeaders } from '../src/gateway/limits'
import { tempCore } from './helpers'

const H = 'anthropic-ratelimit-unified'

describe('parseUnifiedHeaders', () => {
  it('reads the rolling windows, status, claim and reset', () => {
    const headers = new Headers({
      [`${H}-status`]: 'rejected',
      [`${H}-reset`]: '1786147200',
      [`${H}-representative-claim`]: 'five_hour',
      [`${H}-5h-utilization`]: '1.02',
      [`${H}-5h-reset`]: '1786147200',
      [`${H}-7d-utilization`]: '0.384',
      [`${H}-7d-reset`]: '1786500000',
      [`${H}-overage-status`]: 'rejected',
      [`${H}-overage-utilization`]: '0.82',
      [`${H}-overage-reset`]: '1786600000'
    })
    const out = parseUnifiedHeaders(headers)!
    expect(out.status).toBe('rejected')
    expect(out.resetsAt).toBe(1786147200_000)
    expect(out.representativeClaim).toBe('five_hour')
    expect(out.windows).toEqual([
      { label: '5h', usedPercent: 102, periodMs: 5 * 3_600_000, resetsAt: 1786147200_000 },
      { label: 'Weekly', usedPercent: 38.4, periodMs: 7 * 86_400_000, resetsAt: 1786500000_000 }
    ])
    expect(out.overage).toEqual({ status: 'rejected', usedPercent: 82, resetsAt: 1786600000_000 })
  })

  it('returns null without unified headers and tolerates partial ones', () => {
    expect(parseUnifiedHeaders(new Headers({ 'request-id': 'x' }))).toBeNull()
    const out = parseUnifiedHeaders(new Headers({ [`${H}-status`]: 'allowed_warning', [`${H}-5h-utilization`]: 'nope' }))!
    expect(out).toEqual({ status: 'allowed_warning', windows: [] })
    expect(parseUnifiedHeaders(new Headers({ [`${H}-status`]: 'weird' }))!.status).toBeNull()
  })
})

describe('codexSnapshotToWindows', () => {
  it('converts the app-server snapshot in either key style', () => {
    const v2 = codexSnapshotToWindows({
      rateLimits: {
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1786147200 },
        secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1786500000 },
        credits: null
      }
    })
    expect(v2).toEqual([
      { label: '5h', usedPercent: 12, periodMs: 300 * 60_000, resetsAt: 1786147200_000 },
      { label: 'week', usedPercent: 40, periodMs: 10080 * 60_000, resetsAt: 1786500000_000 }
    ])
    const v1 = codexSnapshotToWindows({ primary: { used_percent: 3, window_minutes: 300, resets_at: 1786147200_000 }, secondary: null })
    expect(v1).toEqual([{ label: '5h', usedPercent: 3, periodMs: 300 * 60_000, resetsAt: 1786147200_000 }])
    expect(codexSnapshotToWindows(null)).toEqual([])
    expect(codexSnapshotToWindows({ primary: { windowDurationMins: 300 } })).toEqual([])
  })
})

describe('observeWindows', () => {
  let cleanup = (): void => {}
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('replaces matching labels, keeps the rest, and persists at most every 5 s', () => {
    vi.useFakeTimers()
    const onUsageSample = vi.fn()
    let dataDir: string
    ;({ dataDir, cleanup } = tempCore({ hooks: { onUsageSample } }))
    const path = join(dataDir, 'usage-cache.json')

    const first = accounts.observeWindows('claude-code', 'p', [{ label: '5h', usedPercent: 10, resetsAt: 5 }])!
    expect(first.windows).toEqual([{ label: '5h', usedPercent: 10, resetsAt: 5 }])
    expect(JSON.parse(readFileSync(path, 'utf8'))['claude-code:p'].report.windows[0].usedPercent).toBe(10)
    expect(onUsageSample).toHaveBeenCalledWith(expect.objectContaining({ service: 'claude-code', account: 'p', label: '5h', usedPercent: 10 }))

    // Seed a model-scoped window the poll would have found; it must survive.
    accounts.observeWindows('claude-code', 'p', [{ label: 'Fable', usedPercent: 70 }])
    const second = accounts.observeWindows('claude-code', 'p', [
      { label: '5h', usedPercent: 12, resetsAt: 6 },
      { label: 'Weekly', usedPercent: 40 }
    ])!
    expect(second.windows.map((w) => [w.label, w.usedPercent])).toEqual([
      ['5h', 12],
      ['Fable', 70],
      ['Weekly', 40]
    ])
    // Inside the throttle the file still holds the first write.
    expect(JSON.parse(readFileSync(path, 'utf8'))['claude-code:p'].report.windows).toHaveLength(1)
    vi.advanceTimersByTime(5_000)
    expect(JSON.parse(readFileSync(path, 'utf8'))['claude-code:p'].report.windows).toHaveLength(3)

    expect(accounts.observeWindows('claude-code', 'p', [])).toBeNull()
  })
})
