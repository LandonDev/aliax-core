import { describe, expect, it, vi } from 'vitest'
import { blockedWindow, candidates, hasRoom, limitLabel, liveWindow, orderByReset, orderLabel, pickFromCache, pickNext, requiredTiers, scopedSpent, spendFirstLabels, tiersFor, weeklyLabel, windowOfLabel } from '../src/gateway/failover'
import { classify429 } from '../src/gateway/limits'
import type { UsageReport } from '../src/shared/types'

const NOW = 1_800_000_000_000
const report = (name: string, windows: UsageReport['windows'], extra: Partial<UsageReport> = {}): UsageReport => ({
  profileName: name,
  windows,
  ...extra
})

describe('tiers', () => {
  it('every Claude model spends 5h and Weekly; Fable adds its scoped cap; Codex spends primary and secondary', () => {
    expect(tiersFor('claude-code', 'claude-sonnet-5')).toEqual(['5h', 'Weekly'])
    expect(tiersFor('claude-code', 'claude-fable-5-1')).toEqual(['5h', 'Weekly', 'Fable'])
    expect(tiersFor('claude-code', null)).toEqual(['5h', 'Weekly'])
    expect(tiersFor('codex', 'gpt-6-astra')).toEqual(['5h', 'week'])
  })
  it('the union covers the request and every live model, without repeats', () => {
    expect(requiredTiers('claude-code', 'claude-sonnet-5', ['claude-fable-5-1', 'claude-sonnet-5'])).toEqual(['5h', 'Weekly', 'Fable'])
  })
  it('labels a classified window the way the report does', () => {
    expect(limitLabel('claude-code', 'weekly')).toBe('Weekly')
    expect(limitLabel('codex', 'weekly')).toBe('week')
    expect(limitLabel('claude-code', { model: 'Fable' })).toBe('Fable')
    expect(limitLabel('claude-code', 'credits')).toBe('Credits')
    expect(limitLabel('claude-code', 'transient')).toBeNull()
  })
})

describe('room and ordering', () => {
  it('a full window blocks unless it has already reset; an absent cap and a missing report count as room', () => {
    expect(hasRoom(report('a', [{ label: '5h', usedPercent: 100, resetsAt: NOW + 1 }]), ['5h'], NOW)).toBe(false)
    expect(hasRoom(report('a', [{ label: '5h', usedPercent: 100, resetsAt: NOW - 1 }]), ['5h'], NOW)).toBe(true)
    expect(hasRoom(report('a', [{ label: '5h', usedPercent: 99.9 }]), ['5h', 'Weekly', 'Fable'], NOW)).toBe(true)
    expect(hasRoom(undefined, ['5h'], NOW)).toBe(true)
    expect(hasRoom(report('a', [{ label: '5h', usedPercent: 1 }], { expired: true }), ['5h'], NOW)).toBe(false)
    expect(hasRoom(report('a', [{ label: 'Credits', usedPercent: 100 }]), ['5h'], NOW)).toBe(false)
  })
  it('orders by the weekly reset, unknown last, usage-limited after that; no floor on how full', () => {
    const reports = [
      report('late', [{ label: 'Weekly', usedPercent: 90, resetsAt: NOW + 3_000 }]),
      report('soon', [{ label: 'Weekly', usedPercent: 99, resetsAt: NOW + 1_000 }]),
      report('unknown', [{ label: 'Weekly', usedPercent: 10 }]),
      report('limited', [{ label: 'Weekly', usedPercent: 0, resetsAt: NOW + 500 }], { rateLimit: { provider: 'x', until: NOW + 60_000 } })
    ]
    const names = reports.map((r) => r.profileName).sort(orderByReset(weeklyLabel('claude-code'), reports, NOW))
    expect(names).toEqual(['soon', 'late', 'unknown', 'limited'])
    expect(weeklyLabel('codex')).toBe('week')
  })
  it('a 5h limit still orders by the weekly reset, never the 5h one', () => {
    const reports = [
      report('week-late', [{ label: '5h', usedPercent: 50, resetsAt: NOW + 1 }, { label: 'Weekly', usedPercent: 50, resetsAt: NOW + 9_000 }]),
      report('week-soon', [{ label: '5h', usedPercent: 50, resetsAt: NOW + 9_000 }, { label: 'Weekly', usedPercent: 50, resetsAt: NOW + 1 }])
    ]
    const profiles = ['week-late', 'week-soon'].map((name) => ({ name }))
    expect(candidates({ serviceId: 'claude-code', profiles, reports, required: ['5h', 'Weekly'], tried: [], now: NOW })).toEqual(['week-soon', 'week-late'])
  })
  it('a scoped pick orders by the model\'s own window, falling back to the week when absent; ties go to the fuller account', () => {
    expect(orderLabel('claude-code', 'claude-fable-5-1')).toBe('Fable')
    expect(orderLabel('claude-code', 'claude-opus-5-5')).toBe('Weekly')
    expect(orderLabel('codex', 'gpt-6-astra')).toBe('week')
    const reports = [
      report('fable-late', [{ label: 'Weekly', usedPercent: 10, resetsAt: NOW + 1 }, { label: 'Fable', usedPercent: 40, resetsAt: NOW + 9_000 }]),
      report('fable-soon', [{ label: 'Weekly', usedPercent: 10, resetsAt: NOW + 9_000 }, { label: 'Fable', usedPercent: 40, resetsAt: NOW + 1_000 }]),
      report('fable-soon-fuller', [{ label: 'Weekly', usedPercent: 10, resetsAt: NOW + 9_000 }, { label: 'Fable', usedPercent: 80, resetsAt: NOW + 1_000 }]),
      report('no-fable', [{ label: 'Weekly', usedPercent: 10, resetsAt: NOW + 500 }])
    ]
    const profiles = reports.map((r) => ({ name: r.profileName }))
    expect(candidates({ serviceId: 'claude-code', profiles, reports, required: ['5h', 'Weekly', 'Fable'], tried: [], now: NOW, orderBy: 'Fable' })).toEqual([
      'no-fable',
      'fable-soon-fuller',
      'fable-soon',
      'fable-late'
    ])
  })
  it('a lifted window sorts as unknown, never soonest, and counts as absent', () => {
    const reports = [
      report('stale', [{ label: 'Weekly', usedPercent: 100, resetsAt: NOW - 1 }]),
      report('soon', [{ label: 'Weekly', usedPercent: 50, resetsAt: NOW + 1_000 }]),
      report('unknown', [{ label: 'Weekly', usedPercent: 10 }])
    ]
    const names = reports.map((r) => r.profileName).sort(orderByReset('Weekly', reports, NOW))
    expect(names).toEqual(['soon', 'unknown', 'stale'])
    expect(liveWindow(reports[0], 'Weekly', NOW)).toBeUndefined()
    expect(liveWindow(reports[1], 'Weekly', NOW)?.usedPercent).toBe(50)
  })
  it('a model without a scoped cap spends the accounts whose Fable window is gone first; Fable still needs Fable room', () => {
    expect(spendFirstLabels('claude-code', 'claude-opus-5-5')).toEqual(['Fable'])
    expect(spendFirstLabels('claude-code', 'claude-fable-5-1')).toEqual([])
    expect(spendFirstLabels('codex', 'gpt-6-astra')).toEqual([])
    expect(spendFirstLabels('claude-code', null)).toEqual([])
    const reports = [
      report('fresh', [{ label: 'Weekly', usedPercent: 20, resetsAt: NOW + 1_000 }, { label: 'Fable', usedPercent: 5, resetsAt: NOW + 1_000 }]),
      report('spent', [{ label: 'Weekly', usedPercent: 20, resetsAt: NOW + 1_000 }, { label: 'Fable', usedPercent: 100, resetsAt: NOW + 1_000 }]),
      report('half', [{ label: 'Weekly', usedPercent: 20, resetsAt: NOW + 500 }, { label: 'Fable', usedPercent: 60, resetsAt: NOW + 500 }]),
      report('no-fable', [{ label: 'Weekly', usedPercent: 20, resetsAt: NOW + 1 }]),
      report('lifted', [{ label: 'Weekly', usedPercent: 20, resetsAt: NOW + 2 }, { label: 'Fable', usedPercent: 100, resetsAt: NOW - 1 }])
    ]
    const profiles = reports.map((r) => ({ name: r.profileName }))
    const pick = (model: string, tried: string[] = []): string | null => pickFromCache({ serviceId: 'claude-code', model, scoped: true, profiles, reports, tried, now: NOW })
    // Opus: the spent Fable window first, then the fuller one; no Fable window and a lifted one are full room, ordered by the week.
    expect(pick('claude-opus-5-5')).toBe('spent')
    expect(pick('claude-opus-5-5', ['spent'])).toBe('half')
    expect(pick('claude-opus-5-5', ['spent', 'half'])).toBe('fresh')
    expect(pick('claude-opus-5-5', ['spent', 'half', 'fresh'])).toBe('no-fable')
    expect(pick('claude-opus-5-5', ['spent', 'half', 'fresh', 'no-fable'])).toBe('lifted')
    // Fable: room in its own window is required, soonest Fable reset first; the spent account never comes up.
    expect(pick('claude-fable-5-1')).toBe('no-fable')
    expect(pick('claude-fable-5-1', ['no-fable', 'lifted'])).toBe('half')
    expect(pick('claude-fable-5-1', ['no-fable', 'lifted', 'half', 'fresh'])).toBeNull()
    // The class a host watches: spent, or has room (a lifted or absent window has room).
    expect(scopedSpent('claude-code', 'claude-opus-5-5', reports[1], NOW)).toBe(true)
    expect(scopedSpent('claude-code', 'claude-opus-5-5', reports[0], NOW)).toBe(false)
    expect(scopedSpent('claude-code', 'claude-opus-5-5', reports[4], NOW)).toBe(false)
    expect(scopedSpent('claude-code', 'claude-opus-5-5', undefined, NOW)).toBe(false)
    expect(scopedSpent('claude-code', 'claude-fable-5-1', reports[1], NOW)).toBeNull()
  })
  it('an unscoped pick keeps the weekly order whatever the Fable windows say', () => {
    const reports = [
      report('fresh-soon', [{ label: 'Weekly', usedPercent: 20, resetsAt: NOW + 1 }, { label: 'Fable', usedPercent: 5, resetsAt: NOW + 1 }]),
      report('spent-late', [{ label: 'Weekly', usedPercent: 20, resetsAt: NOW + 9_000 }, { label: 'Fable', usedPercent: 100, resetsAt: NOW + 9_000 }])
    ]
    const profiles = reports.map((r) => ({ name: r.profileName }))
    expect(pickFromCache({ serviceId: 'claude-code', model: 'claude-opus-5-5', profiles, reports, tried: [], now: NOW })).toBe('fresh-soon')
  })
  it('blockedWindow names the full window as a limit, and the label maps back to a window', () => {
    expect(blockedWindow(report('a', [{ label: '5h', usedPercent: 100, resetsAt: NOW + 1 }]), ['5h', 'Weekly'], NOW)).toEqual({ window: '5h', resetsAt: NOW + 1 })
    expect(blockedWindow(report('a', [{ label: 'Fable', usedPercent: 100 }]), ['5h', 'Weekly', 'Fable'], NOW)).toEqual({ window: { model: 'Fable' }, resetsAt: undefined })
    expect(blockedWindow(report('a', [{ label: 'week', usedPercent: 100 }]), ['5h', 'week'], NOW)).toEqual({ window: 'weekly', resetsAt: undefined })
    expect(blockedWindow(report('a', [{ label: '5h', usedPercent: 100, resetsAt: NOW - 1 }]), ['5h'], NOW)).toBeNull()
    expect(blockedWindow(undefined, ['5h'], NOW)).toBeNull()
    expect(windowOfLabel('claude-code', 'Credits')).toBe('credits')
    expect(windowOfLabel('codex', 'week')).toBe('weekly')
  })
  it('candidates drop tried, expired and full accounts', () => {
    const reports = [
      report('a', [{ label: '5h', usedPercent: 100, resetsAt: NOW + 9 }]),
      report('b', [{ label: '5h', usedPercent: 50 }, { label: 'Weekly', usedPercent: 50, resetsAt: NOW + 5 }]),
      report('c', [{ label: '5h', usedPercent: 10 }], { expired: true }),
      report('d', [{ label: '5h', usedPercent: 20 }, { label: 'Weekly', usedPercent: 20, resetsAt: NOW + 1 }, { label: 'Fable', usedPercent: 100, resetsAt: NOW + 99 }])
    ]
    const profiles = ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name }))
    expect(candidates({ serviceId: 'claude-code', profiles, reports, required: ['5h', 'Weekly'], tried: ['a'], now: NOW })).toEqual(['d', 'b', 'e'])
    expect(candidates({ serviceId: 'claude-code', profiles, reports, required: ['5h', 'Weekly', 'Fable'], tried: ['a'], now: NOW })).toEqual(['b', 'e'])
  })
})

describe('pickNext', () => {
  const profiles = ['a', 'b', 'c'].map((name) => ({ name }))
  const reports = [
    report('a', [{ label: '5h', usedPercent: 100, resetsAt: NOW + 9 }]),
    report('b', [{ label: '5h', usedPercent: 50, resetsAt: NOW + 5 }]),
    report('c', [{ label: '5h', usedPercent: 60, resetsAt: NOW + 7 }])
  ]
  it('polls each candidate in order and takes the first that still has room', async () => {
    const poll = vi.fn(async (name: string) =>
      name === 'b' ? report('b', [{ label: '5h', usedPercent: 100, resetsAt: NOW + 5 }]) : reports.find((r) => r.profileName === name)!
    )
    const picked = await pickNext({ serviceId: 'claude-code', model: 'claude-sonnet-5', liveModels: [], window: '5h', profiles, reports, tried: ['a'], poll, now: NOW })
    expect(picked).toBe('c')
    expect(poll.mock.calls.map((c) => c[0])).toEqual(['b', 'c'])
  })
  it('a poll that learns nothing does not block the pick', async () => {
    const picked = await pickNext({ serviceId: 'claude-code', model: null, liveModels: [], window: '5h', profiles, reports, tried: ['a'], poll: async () => null, now: NOW })
    expect(picked).toBe('b')
  })
  it('a scoped pick ignores live models and reads the cache without polling', async () => {
    const poll = vi.fn(async () => null)
    const withFable = [
      report('a', [{ label: '5h', usedPercent: 10 }, { label: 'Weekly', usedPercent: 10, resetsAt: NOW + 1 }, { label: 'Fable', usedPercent: 100, resetsAt: NOW + 9 }]),
      report('b', [{ label: '5h', usedPercent: 10 }, { label: 'Weekly', usedPercent: 10, resetsAt: NOW + 5 }])
    ]
    // Unscoped, with a Fable thread live: a's full Fable cap rules it out.
    expect(await pickNext({ serviceId: 'claude-code', model: 'claude-opus-5-5', liveModels: ['claude-fable-5-1'], window: '5h', profiles, reports: withFable, tried: [], poll, now: NOW })).toBe('b')
    // Scoped to an Opus thread: a is fine, and it resets sooner.
    expect(await pickNext({ serviceId: 'claude-code', model: 'claude-opus-5-5', liveModels: ['claude-fable-5-1'], scoped: true, window: '5h', profiles, reports: withFable, tried: [], poll, now: NOW })).toBe('a')
    expect(pickFromCache({ serviceId: 'claude-code', model: 'claude-fable-5-1', scoped: true, profiles, reports: withFable, tried: [], now: NOW })).toBe('b')
    expect(pickFromCache({ serviceId: 'claude-code', model: 'claude-fable-5-1', scoped: true, profiles, reports: withFable, tried: ['b', 'c'], now: NOW })).toBeNull()
  })
  it('null when every account is tried or full', async () => {
    const picked = await pickNext({ serviceId: 'claude-code', model: null, liveModels: [], window: '5h', profiles, reports, tried: ['a', 'b', 'c'], poll: async () => null, now: NOW })
    expect(picked).toBeNull()
  })
})

describe('classify429', () => {
  const h = (o: Record<string, string>) => new Headers(o)
  it('Claude: rejected + representative-claim names the window, reset from unified-reset', () => {
    expect(
      classify429('claude', h({ 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-representative-claim': 'five_hour', 'anthropic-ratelimit-unified-reset': '1800000000' }), '')
    ).toEqual({ window: '5h', resetsAt: 1_800_000_000_000, claim: 'five_hour' })
    expect(classify429('claude', h({ 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-representative-claim': 'seven_day_fable' }), '').window).toEqual({ model: 'Fable' })
    expect(classify429('claude', h({ 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-representative-claim': 'seven_day_newthing' }), '').window).toBe('weekly')
    expect(classify429('claude', h({ 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-representative-claim': 'overage' }), '').window).toBe('credits')
  })
  it('Claude: body text fills in when the claim is missing; an unnamed rejection charges 5h', () => {
    const rejected = h({ 'anthropic-ratelimit-unified-status': 'rejected' })
    expect(classify429('claude', rejected, '{"error":{"message":"You have hit your weekly limit"}}').window).toBe('weekly')
    expect(classify429('claude', rejected, "You've reached your Opus limit").window).toEqual({ model: 'Opus' })
    expect(classify429('claude', rejected, 'out of credits').window).toBe('credits')
    expect(classify429('claude', rejected, 'nothing recognisable').window).toBe('5h')
  })
  it('Claude: no unified headers, or headers without a rejection, is transient', () => {
    expect(classify429('claude', h({ 'retry-after': '3' }), 'overloaded').window).toBe('transient')
    expect(classify429('claude', h({ 'anthropic-ratelimit-unified-status': 'allowed_warning', 'anthropic-ratelimit-unified-5h-utilization': '0.9' }), '').window).toBe('transient')
  })
  it('Codex: usage_limit_reached by window type, credits, and transient rate_limit_exceeded', () => {
    expect(
      classify429('codex', h({}), JSON.stringify({ error: { type: 'usage_limit_reached', rate_limit_reached_type: 'secondary', resets_at: 1800000000 } }))
    ).toEqual({ window: 'weekly', resetsAt: 1_800_000_000_000, claim: 'secondary' })
    expect(classify429('codex', h({}), JSON.stringify({ error: { code: 'usage_limit_reached', message: 'You have hit your usage limit', resets_in_seconds: 60 } })).window).toBe('5h')
    expect(classify429('codex', h({}), JSON.stringify({ error: { type: 'usage_limit_reached', message: 'weekly limit reached' } })).window).toBe('weekly')
    expect(classify429('codex', h({}), JSON.stringify({ error: { code: 'usage_not_included', message: 'add credits' } })).window).toBe('credits')
    expect(classify429('codex', h({}), JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'slow down' } })).window).toBe('transient')
    expect(classify429('codex', h({}), 'not json').window).toBe('transient')
  })
})
