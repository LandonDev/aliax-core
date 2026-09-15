import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { forward, type ForwardHooks } from '../src/gateway/forward'
import { pinProfile, pinnedProfile } from '../src/settings'
import * as vault from '../src/vault'
import { tempCore } from './helpers'

let cleanup = (): void => {}
let server: Server | null = null
afterEach(async () => {
  cleanup()
  if (server) await new Promise((r) => server!.close(r))
  server = null
})

const codexAuth = (token: string) => JSON.stringify({ tokens: { access_token: token, account_id: `acct-${token}` } })
const limited = (which = 'primary') =>
  new Response(JSON.stringify({ error: { type: 'usage_limit_reached', rate_limit_reached_type: which, resets_at: 1_800_000_000 } }), {
    status: 429,
    headers: { 'content-type': 'application/json' }
  })
const ok = () => new Response('data: {"ok":1}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })

async function serve(hooks: ForwardHooks): Promise<string> {
  server = createServer((req, res) => void forward(req, res, hooks).catch(() => res.end()))
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}

/** Four Codex accounts, A pinned: the fetch answers by bearer token. */
function accounts(dataDir: string): void {
  for (const name of ['A', 'B', 'C', 'D']) {
    vault.upsertProfile('codex', { name, accountId: `acct-${name}`, createdAt: 1 })
    vault.saveSecret('codex', name, codexAuth(name))
  }
  pinProfile('codex', 'A')
  void dataDir
}

describe('forward failover', () => {
  it('replays the buffered body under the next account, pins it, and reports the switch after success', async () => {
    const calls: { auth: string; body: string }[] = []
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const auth = (init!.headers as Record<string, string>).authorization
      calls.push({ auth, body: Buffer.from(init!.body as Uint8Array).toString() })
      return auth === 'Bearer A' ? limited() : ok()
    })
    const { dataDir, cleanup: c } = tempCore({ fetch })
    cleanup = c
    accounts(dataDir)
    const picks: unknown[] = []
    const switched: unknown[] = []
    const base = await serve({
      pickNext: async (info) => {
        picks.push(info)
        return 'B'
      },
      onFailedOver: (info) => switched.push(info)
    })
    const res = await globalThis.fetch(`${base}/codex/v1/responses`, { method: 'POST', body: '{"model":"gpt-6-astra","input":"hi"}' })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('data: {"ok":1}\n\n')
    expect(calls.map((c) => c.auth)).toEqual(['Bearer A', 'Bearer B'])
    expect(calls[1].body).toBe('{"model":"gpt-6-astra","input":"hi"}')
    expect(picks).toEqual([
      { service: 'codex', serviceId: 'codex', model: 'gpt-6-astra', limit: { window: '5h', resetsAt: 1_800_000_000_000, claim: 'primary' }, tried: ['A'] }
    ])
    expect(pinnedProfile('codex')).toBe('B')
    expect(switched).toEqual([{ service: 'codex', serviceId: 'codex', from: 'A', to: 'B' }])
    // A's 5h window reads full with the provider's reset, persisted at once.
    const cache = JSON.parse(readFileSync(join(dataDir, 'usage-cache.json'), 'utf8'))
    expect(cache['codex:A'].report.windows).toEqual([{ label: '5h', usedPercent: 100, resetsAt: 1_800_000_000_000 }])
    // The next request goes straight to B.
    await globalThis.fetch(`${base}/codex/v1/responses`, { method: 'POST', body: '{}' })
    expect(calls.at(-1)!.auth).toBe('Bearer B')
  })

  it('passes the 429 through when no candidate exists, and never reports a switch', async () => {
    const fetch = vi.fn(async () => limited('secondary'))
    const { dataDir, cleanup: c } = tempCore({ fetch })
    cleanup = c
    accounts(dataDir)
    const switched: unknown[] = []
    const base = await serve({ pickNext: async () => null, onFailedOver: (i) => switched.push(i) })
    const res = await globalThis.fetch(`${base}/codex/v1/responses`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(429)
    expect((await res.json()).error.type).toBe('usage_limit_reached')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(pinnedProfile('codex')).toBe('A')
    expect(switched).toEqual([])
  })

  it('bounds the replays and hands the last 429 back when every account is out', async () => {
    const fetch = vi.fn(async () => limited())
    const { dataDir, cleanup: c } = tempCore({ fetch })
    cleanup = c
    accounts(dataDir)
    const order = ['B', 'C', 'D', 'A']
    const tried: string[][] = []
    const base = await serve({
      pickNext: async (info) => {
        tried.push(info.tried)
        return order[tried.length - 1]
      }
    })
    const res = await globalThis.fetch(`${base}/codex/v1/responses`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(429)
    // A plus three replays; D's 429 hits the bound, so nobody asks for a fourth.
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(tried).toEqual([['A'], ['A', 'B'], ['A', 'B', 'C']])
    expect(pinnedProfile('codex')).toBe('D')
  })

  it('a transient 429 is not a failover', async () => {
    const fetch = vi.fn(async () => new Response('{"error":{"code":"rate_limit_exceeded"}}', { status: 429 }))
    const { dataDir, cleanup: c } = tempCore({ fetch })
    cleanup = c
    accounts(dataDir)
    const pickNext = vi.fn(async () => 'B')
    const base = await serve({ pickNext })
    expect((await globalThis.fetch(`${base}/codex/v1/responses`, { method: 'POST', body: '{}' })).status).toBe(429)
    expect(pickNext).not.toHaveBeenCalled()
    expect(pinnedProfile('codex')).toBe('A')
  })

  it('without a pickNext hook the gateway behaves as before', async () => {
    const fetch = vi.fn(async () => limited())
    const { dataDir, cleanup: c } = tempCore({ fetch })
    cleanup = c
    accounts(dataDir)
    const base = await serve({})
    expect((await globalThis.fetch(`${base}/codex/v1/responses`, { method: 'POST', body: '{}' })).status).toBe(429)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
