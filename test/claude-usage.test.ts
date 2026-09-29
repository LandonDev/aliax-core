import { afterEach, describe, expect, it, vi } from 'vitest'
import { adapterForTest } from '../src/accounts'
import { jsonResponse, tempCore } from './helpers'

// The active-profile branch reads the CLI's Keychain; here there is none.
vi.mock('../src/keychain', () => ({
  readPassword: async () => {
    throw new Error('no keychain in tests')
  },
  writePassword: async () => {}
}))

let cleanup = (): void => {}
afterEach(() => cleanup())

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const blob = (exp: number, token = `T${exp}`): string =>
  JSON.stringify({ keychain: JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: `R${exp}`, expiresAt: exp } }), oauthAccount: { accountUuid: 'u' } })
const windows = { limits: [{ kind: 'session', group: 'session', percent: 12 }] }

/** The usage endpoint answers by bearer: a scripted status for the old token, 200 for NEW. Other URLs fail. */
function usageServer(oldStatus: number, retryAfter?: string): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (url !== USAGE_URL) return new Response('nope', { status: 500 })
    const auth = (init!.headers as Record<string, string>).Authorization
    if (auth === 'Bearer NEW') return jsonResponse(windows)
    return new Response('', { status: oldStatus, headers: retryAfter ? { 'retry-after': retryAfter } : {} })
  })
}

const past = Date.now() - 60_000
const future = Date.now() + 3_600_000

describe('claude usage: dead token versus throttle', () => {
  it('a 429 with a retry-after past expiry is a throttle: refresh once under the lock, report the throttle, never expired', async () => {
    ;({ cleanup } = tempCore({ fetch: usageServer(429, '30') }))
    const refresh = vi.fn(async () => blob(future, 'NEW'))
    const out = await adapterForTest('claude-code').usage(blob(past), false, false, refresh)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({ note: 'usage temporarily unavailable', retryAfterMs: 30_000, updatedBlob: blob(future, 'NEW') })
    expect(out.expired).toBeUndefined()
    // Nothing to renew with: still a throttle, not a sign-out.
    const bare = await adapterForTest('claude-code').usage(blob(past), false, false, null)
    expect(bare).toMatchObject({ note: 'usage temporarily unavailable', retryAfterMs: 30_000 })
    expect(bare.expired).toBeUndefined()
  })

  it('a bare 429 past expiry is a dead token: the refreshed token is polled, a failed refresh reports expired', async () => {
    ;({ cleanup } = tempCore({ fetch: usageServer(429) }))
    const a = adapterForTest('claude-code')
    const out = await a.usage(blob(past), false, false, async () => blob(future, 'NEW'))
    expect(out).toMatchObject({ windows: [{ label: '5h', usedPercent: 12 }], updatedBlob: blob(future, 'NEW') })
    expect(await a.usage(blob(past), false, false, async () => null)).toMatchObject({ expired: true })
    expect(await a.usage(blob(past), false, false, null)).toMatchObject({ note: 'waiting for the gateway owner to refresh' })
    // Before expiry a bare 429 is a throttle without a countdown.
    const live = await a.usage(blob(future), false, false, async () => blob(future, 'NEW'))
    expect(live).toMatchObject({ note: 'usage temporarily unavailable' })
    expect(live.retryAfterMs).toBeUndefined()
  })

  it('a 401 is dead whatever the clock says', async () => {
    ;({ cleanup } = tempCore({ fetch: usageServer(401) }))
    const refresh = vi.fn(async () => blob(future, 'NEW'))
    expect(await adapterForTest('claude-code').usage(blob(future), false, false, refresh)).toMatchObject({ windows: [{ label: '5h', usedPercent: 12 }] })
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('the active profile never refreshes: expired only on 401/403 or a bare 429 past expiry, a throttle stays a throttle', async () => {
    ;({ cleanup } = tempCore({ fetch: usageServer(429, '30') }))
    const refresh = vi.fn(async () => blob(future, 'NEW'))
    const a = adapterForTest('claude-code')
    const throttled = await a.usage(blob(past), true, false, refresh)
    expect(throttled).toMatchObject({ note: 'usage temporarily unavailable', retryAfterMs: 30_000 })
    expect(throttled.expired).toBeUndefined()
    cleanup()
    ;({ cleanup } = tempCore({ fetch: usageServer(429) }))
    expect(await a.usage(blob(past), true, false, refresh)).toMatchObject({ expired: true })
    cleanup()
    ;({ cleanup } = tempCore({ fetch: usageServer(403) }))
    expect(await a.usage(blob(future), true, false, refresh)).toMatchObject({ expired: true })
    expect(refresh).not.toHaveBeenCalled()
  })
})
