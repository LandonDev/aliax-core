import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configure } from '../src/config'
import * as accounts from '../src/accounts'
import { forward, splitPath, upstreamFor } from '../src/gateway/forward'
import { CLAUDE_TOKEN_URL } from '../src/oauth'
import { refreshClaude } from '../src/refresh'
import { pinProfile } from '../src/settings'
import * as vault from '../src/vault'
import { jsonResponse, tempCore } from './helpers'

// No CLI Keychain in tests: every Claude profile is a stored one the gateway owns.
vi.mock('../src/adapters/claude', async (orig) => ({
  ...(await orig<typeof import('../src/adapters/claude')>()),
  liveKeychain: async () => null
}))

let cleanup = (): void => {}
let server: Server | null = null
afterEach(async () => {
  cleanup()
  if (server) await new Promise((r) => server!.close(r))
  server = null
})

const codexAuth = (token: string) =>
  JSON.stringify({ tokens: { access_token: token, account_id: 'acct-1' } })
const claudeAuth = (exp: number, token = `T${exp}`) =>
  JSON.stringify({ keychain: JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: `R${exp}`, expiresAt: exp } }), oauthAccount: { accountUuid: 'u' } })
const U = 'anthropic-ratelimit-unified'

describe('forward', () => {
  it('routes by first path segment', () => {
    expect(upstreamFor('claude', '/v1/messages')).toBe('https://api.anthropic.com')
    expect(upstreamFor('codex', '/v1/responses')).toBe('https://chatgpt.com/backend-api/codex')
    expect(upstreamFor('codex', '/plugins')).toBe('https://chatgpt.com/backend-api')
    expect(upstreamFor('nope', '/')).toBeNull()
    expect(splitPath('/codex/api/codex/ps/mcp')).toEqual({ service: 'codex', rest: '/ps/mcp', scope: null })
    // Codex 0.156+ workspace routing discovery, addressed relative to a base without /backend-api.
    expect(splitPath('/codex/api/codex/accounts/check')).toEqual({ service: 'codex', rest: '/wham/accounts/check', scope: null })
    expect(splitPath('/codex/api/codex/settings/user')).toEqual({ service: 'codex', rest: '/wham/settings/user', scope: null })
    expect(upstreamFor('codex', '/wham/accounts/check')).toBe('https://chatgpt.com/backend-api')
  })

  it('swaps Authorization for the pinned account and streams the answer', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return jsonResponse({ ok: 1 }, { headers: { 'x-upstream': 'yes', 'content-encoding': 'gzip' } })
    })
    ;({ cleanup } = tempCore({ fetch }))
    vault.upsertProfile('codex', { name: 'p', accountId: 'acct-1', createdAt: 1 })
    vault.saveSecret('codex', 'p', codexAuth('PINNED'))
    pinProfile('codex', 'p')

    const seen: number[] = []
    server = createServer((req, res) => {
      forward(req, res, { onResponse: (i) => seen.push(i.status) }).catch(() => res.end())
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    const res = await globalThis.fetch(`http://127.0.0.1:${port}/codex/v1/responses`, {
      method: 'POST',
      headers: { authorization: 'Bearer CLI-TOKEN', 'x-api-key': 'k', 'sec-fetch-mode': 'cors' },
      body: '{"hi":1}'
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-upstream')).toBe('yes')
    expect(res.headers.get('content-encoding')).toBeNull()
    expect(await res.json()).toEqual({ ok: 1 })
    expect(seen).toEqual([200])
    expect(calls[0].url).toBe('https://chatgpt.com/backend-api/codex/v1/responses')
    const headers = calls[0].init!.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer PINNED')
    expect(headers['chatgpt-account-id']).toBe('acct-1')
    expect(headers['x-api-key']).toBeUndefined()
    expect(headers['sec-fetch-mode']).toBeUndefined()
    expect(Buffer.from(calls[0].init!.body as Uint8Array).toString()).toBe('{"hi":1}')
  })

  it('answers 503 with no usable sign-in and 404 for an unknown service', async () => {
    ;({ cleanup } = tempCore())
    pinProfile('codex', 'ghost')
    server = createServer((req, res) => void forward(req, res))
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    expect((await globalThis.fetch(`http://127.0.0.1:${port}/other/x`)).status).toBe(404)
    process.env.HOME = '/nonexistent'
    try {
      expect((await globalThis.fetch(`http://127.0.0.1:${port}/codex/v1/x`)).status).toBe(503)
    } finally {
      delete process.env.HOME
      configure({ dataDir: '/tmp', fetch: globalThis.fetch, secrets: { mode: 'chromiumKey', keychainItem: 'x' } })
    }
  })
  it('hands a 429 body to the hook and still delivers it to the client', async () => {
    const fetch = vi.fn(async () =>
      new Response('{"type":"error","error":{"type":"rate_limit_error"}}', {
        status: 429,
        headers: { 'anthropic-ratelimit-unified-status': 'rejected' }
      })
    )
    ;({ cleanup } = tempCore({ fetch }))
    vault.upsertProfile('codex', { name: 'p', accountId: 'acct-1', createdAt: 1 })
    vault.saveSecret('codex', 'p', codexAuth('PINNED'))
    pinProfile('codex', 'p')
    const seen: { status: number; body?: string }[] = []
    server = createServer((req, res) => {
      void forward(req, res, { onResponse: (info) => seen.push({ status: info.status, body: info.body }) })
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    const res = await globalThis.fetch(`http://127.0.0.1:${port}/codex/v1/responses`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(429)
    expect(await res.text()).toContain('rate_limit_error')
    expect(seen).toEqual([{ status: 429, body: '{"type":"error","error":{"type":"rate_limit_error"}}' }])
  })

  it('hands the model to the hook and charges a Fable-claim 429 to the Fable window', async () => {
    const fetch = vi.fn(async () =>
      new Response('{"type":"error","error":{"type":"rate_limit_error"}}', {
        status: 429,
        headers: { [`${U}-status`]: 'rejected', [`${U}-representative-claim`]: 'seven_day_overage_included', [`${U}-reset`]: '1786500000', [`${U}-7d_oi-status`]: 'rejected' }
      })
    )
    ;({ cleanup } = tempCore({ fetch }))
    vault.upsertProfile('claude-code', { name: 'p', accountId: 'u', createdAt: 1 })
    vault.saveSecret('claude-code', 'p', claudeAuth(Date.now() + 3_600_000))
    pinProfile('claude-code', 'p')
    const seen: { model: string | null; account: string | null }[] = []
    server = createServer((req, res) => {
      void forward(req, res, { onResponse: (i) => seen.push({ model: i.model, account: i.account }), pickNext: async () => null })
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    const res = await globalThis.fetch(`http://127.0.0.1:${port}/claude/v1/messages`, { method: 'POST', body: '{"model":"claude-fable-5-1"}' })
    expect(res.status).toBe(429)
    expect(seen).toEqual([{ model: 'claude-fable-5-1', account: 'p' }])
    const windows = accounts.cachedReport('claude-code', 'p')?.windows
    expect(windows).toEqual([{ label: 'Fable', usedPercent: 100, resetsAt: 1786500000_000 }])
  })

  it('the gateway refresh and a poll refresh share one lock: one POST for a concurrent pair', async () => {
    const presented: string[] = []
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === CLAUDE_TOKEN_URL) {
        presented.push(JSON.parse(init!.body as string).refresh_token)
        await new Promise((r) => setTimeout(r, 10))
        return jsonResponse({ access_token: 'NEW', refresh_token: 'R-NEW', expires_in: 3600 })
      }
      return jsonResponse({ ok: 1 })
    })
    ;({ cleanup } = tempCore({ fetch }))
    vault.upsertProfile('claude-code', { name: 'p', accountId: 'u', createdAt: 1 })
    const stale = claudeAuth(Date.now() + 1000)
    vault.saveSecret('claude-code', 'p', stale)
    pinProfile('claude-code', 'p')
    server = createServer((req, res) => void forward(req, res))
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    const [res, polled] = await Promise.all([
      globalThis.fetch(`http://127.0.0.1:${port}/claude/v1/messages`, { method: 'POST', body: '{}' }),
      refreshClaude('p', stale)
    ])
    expect(res.status).toBe(200)
    expect(presented).toEqual([`R${JSON.parse(JSON.parse(stale).keychain).claudeAiOauth.expiresAt}`])
    expect(polled).toBe(vault.readSecret('claude-code', 'p'))
    const sent = (fetch.mock.calls.find((c) => c[0] !== CLAUDE_TOKEN_URL)![1] as RequestInit).headers as Record<string, string>
    expect(sent.authorization).toBe('Bearer NEW')
  })
})
