import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as accounts from '../src/accounts'
import { clearRoutes, forward, parseScope, routeOf, splitPath, type ForwardHooks } from '../src/gateway/forward'
import { OPENAI_TOKEN_URL } from '../src/oauth'
import { pinProfile, pinnedProfile } from '../src/settings'
import * as vault from '../src/vault'
import { tempCore } from './helpers'

let cleanup = (): void => {}
let server: Server | null = null
afterEach(async () => {
  cleanup()
  clearRoutes()
  if (server) await new Promise((r) => server!.close(r))
  server = null
})

const codexAuth = (token: string) => JSON.stringify({ tokens: { access_token: token, account_id: `acct-${token}` } })
const limited = (which = 'primary', resetsAt = 1_800_000_000) =>
  new Response(JSON.stringify({ error: { type: 'usage_limit_reached', rate_limit_reached_type: which, resets_at: resetsAt } }), {
    status: 429,
    headers: { 'content-type': 'application/json' }
  })
const ok = () => new Response('data: {"ok":1}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })

async function serve(hooks: ForwardHooks): Promise<string> {
  server = createServer((req, res) => void forward(req, res, hooks).catch(() => res.end()))
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}

/** Three Codex accounts, A pinned globally; the fetch answers by bearer token. */
function seed(): void {
  for (const name of ['A', 'B', 'C']) {
    vault.upsertProfile('codex', { name, accountId: `acct-${name}`, createdAt: 1 })
    vault.saveSecret('codex', name, codexAuth(name))
  }
  pinProfile('codex', 'A')
}

const scoped = (thread: string, account: string, pin = false) =>
  `/codex/~t=${encodeURIComponent(thread)};a=${encodeURIComponent(account)}${pin ? ';pin=1' : ''}/v1/responses`

describe('scope parsing', () => {
  it('reads thread, account and pin off the segment, decoding each field', () => {
    expect(parseScope('~t=th-1;a=me%40x.io;pin=1')).toEqual({ thread: 'th-1', account: 'me@x.io', pin: true })
    expect(parseScope('~t=th-1;a=B')).toEqual({ thread: 'th-1', account: 'B', pin: false })
    expect(parseScope('~t=th-1')).toBeNull()
    expect(parseScope('v1')).toBeNull()
    expect(parseScope('~t=%E0%A4%A;a=B')).toBeNull()
  })
  it('splitPath strips the scope before the upstream path, and leaves other paths alone', () => {
    expect(splitPath('/claude/~t=T;a=me%40x.io;pin=1/v1/messages')).toEqual({
      service: 'claude',
      rest: '/v1/messages',
      scope: { thread: 'T', account: 'me@x.io', pin: true }
    })
    expect(splitPath('/codex/~t=T;a=B/api/codex/ps/mcp')).toEqual({ service: 'codex', rest: '/ps/mcp', scope: { thread: 'T', account: 'B', pin: false } })
    expect(splitPath('/codex/~t=T;a=B')).toEqual({ service: 'codex', rest: '', scope: { thread: 'T', account: 'B', pin: false } })
    expect(splitPath('/claude/~weird/v1/messages')).toEqual({ service: 'claude', rest: '/~weird/v1/messages', scope: null })
  })
})

describe('scoped forwarding', () => {
  it('spends from the named account and never touches the pin', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => ok())
    cleanup = tempCore({ fetch }).cleanup
    seed()
    const seen: unknown[] = []
    const base = await serve({ onResponse: (i) => seen.push(i.account) })
    const res = await globalThis.fetch(`${base}${scoped('T', 'B')}`, { method: 'POST', body: '{"model":"gpt-6-astra"}' })
    expect(res.status).toBe(200)
    expect((fetch.mock.calls[0][1] as RequestInit).headers).toMatchObject({ authorization: 'Bearer B' })
    expect(fetch.mock.calls[0][0]).toBe('https://chatgpt.com/backend-api/codex/v1/responses')
    expect(seen).toEqual(['B'])
    expect(pinnedProfile('codex')).toBe('A')
  })

  it('an account the vault does not hold is a clear 503', async () => {
    const fetch = vi.fn(async () => ok())
    cleanup = tempCore({ fetch }).cleanup
    seed()
    const base = await serve({})
    const res = await globalThis.fetch(`${base}${scoped('T', 'nobody')}`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(503)
    expect((await res.json()).error.message).toContain('"nobody"')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('a 429 moves only this thread, replays, and the next request goes straight to the override', async () => {
    const calls: string[] = []
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const auth = (init!.headers as Record<string, string>).authorization
      calls.push(auth)
      return auth === 'Bearer A' ? limited() : ok()
    })
    const { dataDir, cleanup: c } = tempCore({ fetch })
    cleanup = c
    seed()
    const picks: unknown[] = []
    const routed: unknown[] = []
    const failedOver: unknown[] = []
    const base = await serve({
      pickNext: async (info) => {
        picks.push(info)
        return 'B'
      },
      onRouted: (i) => routed.push(i),
      onFailedOver: (i) => failedOver.push(i)
    })
    const res = await globalThis.fetch(`${base}${scoped('T', 'A')}`, { method: 'POST', body: '{"model":"gpt-6-astra"}' })
    expect(res.status).toBe(200)
    expect(calls).toEqual(['Bearer A', 'Bearer B'])
    expect(picks).toEqual([
      {
        service: 'codex',
        serviceId: 'codex',
        model: 'gpt-6-astra',
        limit: { window: '5h', resetsAt: 1_800_000_000_000, claim: 'primary' },
        tried: ['A'],
        account: 'A',
        thread: 'T'
      }
    ])
    expect(routed).toEqual([{ service: 'codex', serviceId: 'codex', thread: 'T', account: 'B' }])
    expect(failedOver).toEqual([])
    expect(pinnedProfile('codex')).toBe('A')
    expect(routeOf('T')).toBe('B')
    const cache = JSON.parse(readFileSync(join(dataDir, 'usage-cache.json'), 'utf8'))
    expect(cache['codex:A'].report.windows).toEqual([{ label: '5h', usedPercent: 100, resetsAt: 1_800_000_000_000 }])

    // The next request for T goes to B without asking; a sibling on A still spends A.
    await globalThis.fetch(`${base}${scoped('T', 'A')}`, { method: 'POST', body: '{"model":"gpt-6-astra"}' })
    expect(calls.at(-1)).toBe('Bearer B')
    expect(picks).toHaveLength(1)
    expect(routed).toHaveLength(1)
    // An unscoped request still follows the pin (A), and still moves it when A is out.
    await globalThis.fetch(`${base}/codex/v1/responses`, { method: 'POST', body: '{"model":"gpt-6-astra"}' })
    expect(calls.slice(-2)).toEqual(['Bearer A', 'Bearer B'])
    expect(pinnedProfile('codex')).toBe('B')
  })

  it('a thread whose account the cache shows full is moved before the request goes out', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => ok())
    cleanup = tempCore({ fetch }).cleanup
    seed()
    accounts.observeLimit('codex', 'A', { window: 'weekly', resetsAt: Date.now() + 3_600_000 })
    const picks: unknown[] = []
    const base = await serve({
      pickNext: async (info) => {
        picks.push(info)
        return 'C'
      }
    })
    await globalThis.fetch(`${base}${scoped('U', 'A')}`, { method: 'POST', body: '{"model":"gpt-6-astra"}' })
    expect((fetch.mock.calls[0][1] as RequestInit).headers).toMatchObject({ authorization: 'Bearer C' })
    expect(picks).toMatchObject([{ limit: { window: 'weekly' }, tried: ['A'], account: 'A', thread: 'U' }])
    expect(routeOf('U')).toBe('C')
  })

  it('a pinned thread returns to its pin once the cache shows room; an automatic one stays put', async () => {
    const calls: string[] = []
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push((init!.headers as Record<string, string>).authorization)
      return ok()
    })
    cleanup = tempCore({ fetch }).cleanup
    seed()
    const routed: string[] = []
    const base = await serve({ pickNext: async () => 'B', onRouted: (i) => routed.push(`${i.thread}:${i.account}`) })

    // Both threads start on A while A's week is full: both move to B.
    accounts.observeLimit('codex', 'A', { window: 'weekly', resetsAt: Date.now() + 1_000 })
    await globalThis.fetch(`${base}${scoped('pinned', 'A', true)}`, { method: 'POST', body: '{}' })
    await globalThis.fetch(`${base}${scoped('auto', 'A')}`, { method: 'POST', body: '{}' })
    expect(calls).toEqual(['Bearer B', 'Bearer B'])
    expect(routed).toEqual(['pinned:B', 'auto:B'])

    // A's week resets: the pinned thread goes home, the automatic one keeps B.
    accounts.observeLimit('codex', 'A', { window: 'weekly', resetsAt: Date.now() - 1 })
    await globalThis.fetch(`${base}${scoped('pinned', 'A', true)}`, { method: 'POST', body: '{}' })
    await globalThis.fetch(`${base}${scoped('auto', 'A')}`, { method: 'POST', body: '{}' })
    expect(calls.slice(2)).toEqual(['Bearer A', 'Bearer B'])
    expect(routed).toEqual(['pinned:B', 'auto:B', 'pinned:A'])
    expect(routeOf('pinned')).toBeUndefined()
    expect(routeOf('auto')).toBe('B')
  })

  it('a 429 with nobody to pick passes through and leaves the thread where it was', async () => {
    const fetch = vi.fn(async () => limited('secondary'))
    cleanup = tempCore({ fetch }).cleanup
    seed()
    const routed: unknown[] = []
    const base = await serve({ pickNext: async () => null, onRouted: (i) => routed.push(i) })
    const res = await globalThis.fetch(`${base}${scoped('T', 'B')}`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(429)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(routed).toEqual([])
    expect(routeOf('T')).toBeUndefined()
    expect(pinnedProfile('codex')).toBe('A')
  })
})

/** A Codex access token that the refresh check reads `exp` from. */
const jwt = (exp: number): string =>
  `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`

describe('refresh lock', () => {
  it('two profiles refresh side by side; the same profile refreshes once', async () => {
    const refreshes: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === OPENAI_TOKEN_URL) {
        const { refresh_token } = JSON.parse(init!.body as string)
        refreshes.push(refresh_token)
        await gate
        return new Response(JSON.stringify({ access_token: `fresh-${refresh_token}`, refresh_token: `${refresh_token}2` }), { status: 200 })
      }
      return ok()
    })
    cleanup = tempCore({ fetch }).cleanup
    const expiring = Math.floor(Date.now() / 1000) + 10
    for (const name of ['A', 'B']) {
      vault.upsertProfile('codex', { name, accountId: `acct-${name}`, createdAt: 1 })
      vault.saveSecret('codex', name, JSON.stringify({ tokens: { access_token: jwt(expiring), refresh_token: `rt-${name}` } }))
    }
    const base = await serve({})
    const inflight = [
      globalThis.fetch(`${base}${scoped('1', 'A')}`, { method: 'POST', body: '{}' }),
      globalThis.fetch(`${base}${scoped('2', 'A')}`, { method: 'POST', body: '{}' }),
      globalThis.fetch(`${base}${scoped('3', 'B')}`, { method: 'POST', body: '{}' })
    ]
    // Both grants are in flight before either answers: the lock is per profile.
    await vi.waitFor(() => expect(refreshes.sort()).toEqual(['rt-A', 'rt-B']))
    release()
    await Promise.all(inflight)
    const auths = fetch.mock.calls.filter((c) => c[0] !== OPENAI_TOKEN_URL).map((c) => (c[1]!.headers as Record<string, string>).authorization)
    expect(auths.sort()).toEqual(['Bearer fresh-rt-A', 'Bearer fresh-rt-A', 'Bearer fresh-rt-B'])
  })
})
