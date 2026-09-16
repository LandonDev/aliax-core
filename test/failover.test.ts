import { describe, expect, it, vi } from 'vitest'
import { candidates, hasRoom, limitLabel, orderByReset, pickNext, requiredTiers, tiersFor, weeklyLabel } from '../src/gateway/failover'
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
