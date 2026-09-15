import { readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as accounts from '../src/accounts'
import { configure } from '../src/config'
import type { Adapter } from '../src/adapters/types'
import * as vault from '../src/vault'
import { noFetch, tempCore } from './helpers'

let cleanup = (): void => {}
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** Replace the codex adapter's network-facing pieces with a scripted stand-in. */
function stubCodex(usage: Adapter['usage']): void {
  const a = accounts.adapterForTest('codex')
  vi.spyOn(a, 'liveAccountId').mockResolvedValue(null)
  vi.spyOn(a, 'usage').mockImplementation(usage)
}

describe('accounts.usage cache gates', () => {
  it('serves the cache inside the TTL and re-polls on force', async () => {
    ;({ cleanup } = tempCore())
    vault.upsertProfile('codex', { name: 'p', accountId: '1', createdAt: 1 })
    vault.saveSecret('codex', 'p', '{}')
    const usage = vi.fn(async () => ({ windows: [{ label: '5h', usedPercent: 10 }] }))
    stubCodex(usage)
    await accounts.usage('codex')
    await accounts.usage('codex')
    expect(usage).toHaveBeenCalledTimes(1)
    await accounts.usage('codex', true)
    expect(usage).toHaveBeenCalledTimes(2)
  })

  it('never re-knocks while a rate limit countdown runs, even on force', async () => {
    ;({ cleanup } = tempCore())
    vault.upsertProfile('codex', { name: 'p', accountId: '1', createdAt: 1 })
    vault.saveSecret('codex', 'p', '{}')
    const usage = vi.fn(async () => ({
      windows: [],
      note: 'usage temporarily unavailable',
      retryAfterMs: 60_000
    }))
    stubCodex(usage)
    const [first] = await accounts.usage('codex')
    expect(first.rateLimit?.until).toBeGreaterThan(Date.now())
    await accounts.usage('codex', true)
    expect(usage).toHaveBeenCalledTimes(1)
  })

  it('passes mayRefresh=false when the app is standby', async () => {
    ;({ cleanup } = tempCore({ role: () => 'standby' }))
    vault.upsertProfile('codex', { name: 'p', accountId: '1', createdAt: 1 })
    vault.saveSecret('codex', 'p', '{}')
    const usage = vi.fn(async () => ({ windows: [] }))
    stubCodex(usage)
    await accounts.usage('codex')
    expect((usage.mock.calls[0] as unknown[])[3]).toBe(false)
  })

  it('reloads the cache file when another process rewrote it', async () => {
    const { dataDir, cleanup: c } = tempCore()
    cleanup = c
    vault.upsertProfile('codex', { name: 'p', accountId: '1', createdAt: 1 })
    vault.saveSecret('codex', 'p', '{}')
    stubCodex(async () => ({ windows: [{ label: '5h', usedPercent: 10 }] }))
    await accounts.usage('codex')
    const path = join(dataDir, 'usage-cache.json')
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    raw['codex:p'].report.windows[0].usedPercent = 77
    writeFileSync(path, JSON.stringify(raw))
    const later = new Date(Date.now() + 5_000)
    utimesSync(path, later, later)
    const [report] = await accounts.usage('codex')
    expect(report.windows[0].usedPercent).toBe(77)
  })

  it('emits usage samples through the hook', async () => {
    const onUsageSample = vi.fn()
    ;({ cleanup } = tempCore({ hooks: { onUsageSample } }))
    vault.upsertProfile('codex', { name: 'p', accountId: '1', createdAt: 1 })
    vault.saveSecret('codex', 'p', '{}')
    stubCodex(async () => ({ windows: [{ label: 'week', usedPercent: 3 }] }))
    await accounts.usage('codex')
    expect(onUsageSample).toHaveBeenCalledWith(
      expect.objectContaining({ service: 'codex', account: 'p', label: 'week', usedPercent: 3 })
    )
  })
})

describe('saveSecretUnlessOlder', () => {
  it('keeps the fresher stored copy', () => {
    ;({ cleanup } = tempCore())
    const a = accounts.adapterForTest('claude-code')
    const blob = (exp: number) => JSON.stringify({ keychain: JSON.stringify({ claudeAiOauth: { expiresAt: exp } }) })
    vault.saveSecret('claude-code', 'p', blob(2000))
    expect(accounts.saveSecretUnlessOlder(a, 'p', blob(1000))).toBe(false)
    expect(accounts.saveSecretUnlessOlder(a, 'p', blob(3000))).toBe(true)
    expect(a.freshness!(vault.readSecret('claude-code', 'p')!)).toBe(3000)
  })
})

describe('configure guard', () => {
  it('throws before configure', () => {
    // @ts-expect-error resetting for the test
    configure(null)
    expect(() => vault.saveSecret('codex', 'x', 'y')).toThrow(/configure/)
    configure({ dataDir: '/tmp', fetch: noFetch, secrets: { mode: 'chromiumKey', keychainItem: 'x' } })
  })
})
