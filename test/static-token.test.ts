import { afterEach, describe, expect, it, vi } from 'vitest'
import { adapterForTest } from '../src/accounts'
import { OPENAI_TOKEN_URL } from '../src/oauth'
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
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile'
const YEAR = 365 * 86_400_000
const staticBlob = (exp: number): string =>
  JSON.stringify({ keychain: JSON.stringify({ claudeAiOauth: { accessToken: 'OAT', expiresAt: exp, scopes: ['user:inference'] } }), oauthAccount: { accountUuid: 'u' }, tokenKind: 'static' })

describe('claude usage with a static token', () => {
  it('an inference-only token the usage endpoint refuses is not a sign-out, and nothing is refreshed', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url === USAGE_URL || url === PROFILE_URL) return new Response('', { status: 403 })
      throw new Error(`unexpected fetch ${url}`)
    })
    ;({ cleanup } = tempCore({ fetch }))
    const refresh = vi.fn(async () => null)
    const out = await adapterForTest('claude-code').usage(staticBlob(Date.now() + YEAR), false, false, refresh)
    expect(out).toEqual({ windows: [], note: 'one-year token: usage is not reported' })
    expect(refresh).not.toHaveBeenCalled()
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([USAGE_URL])
  })

  it('reports windows when the endpoint allows the token, a throttle as a throttle, and expired only by its own clock', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url === USAGE_URL) return jsonResponse({ limits: [{ kind: 'session', group: 'session', percent: 7 }] })
      throw new Error(`unexpected fetch ${url}`)
    })
    ;({ cleanup } = tempCore({ fetch }))
    const a = adapterForTest('claude-code')
    expect(await a.usage(staticBlob(Date.now() + YEAR), false, false, null)).toEqual({ windows: [{ label: '5h', usedPercent: 7, periodMs: 5 * 3_600_000, resetsAt: undefined }] })
    expect(await a.usage(staticBlob(Date.now() - 1), false, false, null)).toEqual({ windows: [], expired: true })
    expect(fetch).toHaveBeenCalledTimes(1)
    cleanup()
    ;({ cleanup } = tempCore({ fetch: async () => new Response('', { status: 429, headers: { 'retry-after': '20' } }) }))
    expect(await a.usage(staticBlob(Date.now() + YEAR), false, false, null)).toEqual({ windows: [], note: 'usage temporarily unavailable', retryAfterMs: 20_000 })
  })
})

describe('codex usage renews through the callback', () => {
  const jwt = (exp: number): string => `h.${Buffer.from(JSON.stringify({ exp: Math.floor(exp / 1000) })).toString('base64url')}.s`
  const blob = (exp: number, token = jwt(exp)): string => JSON.stringify({ tokens: { access_token: token, refresh_token: 'CR', account_id: 'acct' } })
  const USAGE = 'https://chatgpt.com/backend-api/codex/usage'

  it('a saved copy near its end asks the callback, never the token endpoint itself', async () => {
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === OPENAI_TOKEN_URL) throw new Error('the adapter must not refresh in place')
      if (url !== USAGE) throw new Error(`unexpected fetch ${url}`)
      const auth = (init!.headers as Record<string, string>).Authorization
      if (auth === 'Bearer NEW') return jsonResponse({ rate_limit: { primary_window: { used_percent: 3, limit_window_seconds: 18000 } } })
      return new Response('', { status: 401 })
    })
    ;({ cleanup } = tempCore({ fetch }))
    const renewed = blob(Date.now() + 9 * 86_400_000, 'NEW')
    const refresh = vi.fn(async () => renewed)
    const out = await adapterForTest('codex').usage(blob(Date.now() + 86_400_000), false, false, refresh)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({ windows: [{ label: '5h', usedPercent: 3 }], updatedBlob: renewed })
    // Without a callback the copy is left alone and the row says so.
    const waiting = await adapterForTest('codex').usage(blob(Date.now() - 1000), false, false, null)
    expect(waiting).toMatchObject({ note: 'waiting for the gateway owner to refresh' })
  })
})
