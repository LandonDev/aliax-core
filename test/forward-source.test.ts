import { createServer, type Server } from 'node:http'
import { readdirSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleControl } from '../src/gateway/control'
import { clearRoutes, credentialFor, forward, routeOf, type AccountSource, type ForwardHooks } from '../src/gateway/forward'
import type { Limit } from '../src/gateway/limits'
import { useCredentialBackend } from '../src/credentials'
import type { ServiceId, UsageReport } from '../src/shared/types'
import * as vault from '../src/vault'
import { tempCore } from './helpers'

let cleanup = (): void => {}
let server: Server | null = null
afterEach(async () => {
  cleanup()
  clearRoutes()
  useCredentialBackend(null)
  if (server) await new Promise((r) => server!.close(r))
  server = null
})

const ok = () => new Response('data: {"ok":1}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } })
const limited = () =>
  new Response(JSON.stringify({ error: { type: 'usage_limit_reached', rate_limit_reached_type: 'primary', resets_at: 1_800_000_000 } }), {
    status: 429,
    headers: { 'content-type': 'application/json' }
  })

async function serve(hooks: ForwardHooks): Promise<string> {
  server = createServer((req, res) => void forward(req, res, hooks).catch(() => res.end()))
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}

/** Any Keychain or credentials-file read throws: a forward given a source must never make one. */
function forbidKeychain(): { reads: string[] } {
  const reads: string[] = []
  useCredentialBackend({
    kind: 'file',
    read: async (service) => {
      reads.push(service)
      throw new Error(`keychain read of ${service}`)
    },
    write: async (service) => {
      throw new Error(`keychain write of ${service}`)
    }
  })
  return { reads }
}

/** A host's copy of its accounts: names, a pin, reports, and a log of what the forward asked and told it. */
function source(names: string[], pinned: string, reports: Record<string, UsageReport> = {}) {
  const asked: string[] = []
  const limits: { serviceId: ServiceId; name: string; limit: Limit }[] = []
  const pins: string[] = []
  let pin = pinned
  const accounts: AccountSource = {
    credentialFor: async (service, account) => {
      asked.push(`${service}:${account ?? '(pinned)'}`)
      return { authorization: `Bearer ${account ?? pin}`, extraHeaders: { 'x-from': 'source' } }
    },
    hasProfile: async (_serviceId, name) => names.includes(name),
    pinned: async () => pin,
    report: async (serviceId, name) => reports[`${serviceId}:${name}`],
    observeLimit: (serviceId, name, limit) => limits.push({ serviceId, name, limit }),
    pin: async (_serviceId, name) => {
      pins.push(name)
      pin = name
    }
  }
  return { accounts, asked, limits, pins }
}

describe('forward with an account source', () => {
  it('takes credentials, the profile check and the pin from the source and reads nothing of this machine', async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => ok())
    const { dataDir, cleanup: c } = tempCore({ fetch })
    cleanup = c
    const { reads } = forbidKeychain()
    const src = source(['A', 'B'], 'A')
    const answered: (string | null)[] = []
    const base = await serve({ accounts: src.accounts, onResponse: (i) => answered.push(i.account) })

    const scoped = await globalThis.fetch(`${base}/claude/~t=T;a=B/v1/messages`, { method: 'POST', body: '{"model":"claude-opus-5-5"}' })
    expect(scoped.status).toBe(200)
    const unscoped = await globalThis.fetch(`${base}/claude/v1/messages`, { method: 'POST', body: '{"model":"claude-opus-5-5"}' })
    expect(unscoped.status).toBe(200)

    expect(fetch.mock.calls.map((call) => (call[1] as RequestInit).headers)).toMatchObject([
      { authorization: 'Bearer B', 'x-from': 'source' },
      { authorization: 'Bearer A', 'x-from': 'source' }
    ])
    expect(src.asked).toEqual(['claude:B', 'claude:(pinned)'])
    expect(answered).toEqual(['B', 'A'])
    // The vault holds nothing and was never needed; no Keychain read, no file written.
    expect(vault.profiles('claude-code')).toEqual([])
    expect(reads).toEqual([])
    expect(readdirSync(dataDir)).toEqual([])
  })

  it('an account the source does not know is a clear 503 and nothing goes out', async () => {
    const fetch = vi.fn(async () => ok())
    cleanup = tempCore({ fetch }).cleanup
    const src = source(['A'], 'A')
    const base = await serve({ accounts: src.accounts })
    const res = await globalThis.fetch(`${base}/codex/~t=T;a=nobody/v1/responses`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(503)
    expect((await res.json()).error.message).toContain('"nobody"')
    expect(fetch).not.toHaveBeenCalled()
    expect(src.asked).toEqual([])
  })

  it('a 429 is charged and the pin moved through the source, never in the usage cache or the settings file', async () => {
    const calls: string[] = []
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const auth = (init!.headers as Record<string, string>).authorization
      calls.push(auth)
      return auth === 'Bearer A' ? limited() : ok()
    })
    const { dataDir, cleanup: c } = tempCore({ fetch })
    cleanup = c
    const src = source(['A', 'B'], 'A')
    const failedOver: unknown[] = []
    const base = await serve({ accounts: src.accounts, pickNext: async () => 'B', onFailedOver: (i) => failedOver.push(i) })
    const res = await globalThis.fetch(`${base}/codex/v1/responses`, { method: 'POST', body: '{"model":"gpt-6-astra"}' })
    expect(res.status).toBe(200)
    expect(calls).toEqual(['Bearer A', 'Bearer B'])
    expect(src.limits).toEqual([{ serviceId: 'codex', name: 'A', limit: { window: '5h', resetsAt: 1_800_000_000_000, claim: 'primary' } }])
    expect(src.pins).toEqual(['B'])
    expect(failedOver).toEqual([{ service: 'codex', serviceId: 'codex', from: 'A', to: 'B' }])
    expect(readdirSync(dataDir)).toEqual([])
  })

  it("the source's report moves a thread off a full account before the request goes out", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => ok())
    cleanup = tempCore({ fetch }).cleanup
    const full: UsageReport = { profileName: 'A', windows: [{ label: 'week', usedPercent: 100, resetsAt: Date.now() + 3_600_000 }] }
    const src = source(['A', 'C'], 'A', { 'codex:A': full })
    const picks: unknown[] = []
    const base = await serve({
      accounts: src.accounts,
      pickNext: async (info) => {
        picks.push(info)
        return 'C'
      }
    })
    await globalThis.fetch(`${base}/codex/~t=U;a=A/v1/responses`, { method: 'POST', body: '{"model":"gpt-6-astra"}' })
    expect((fetch.mock.calls[0][1] as RequestInit).headers).toMatchObject({ authorization: 'Bearer C' })
    expect(picks).toMatchObject([{ limit: { window: 'weekly' }, tried: ['A'], account: 'A', thread: 'U' }])
    expect(routeOf('U')).toBe('C')
  })
})

describe('credential expiry', () => {
  it("names the access token's end: a Codex JWT's exp, a Claude blob's expiresAt", async () => {
    cleanup = tempCore().cleanup
    useCredentialBackend({ kind: 'file', read: async () => null, write: async () => {} })
    const exp = Math.floor(Date.now() / 1000) + 3_600
    const jwt = `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`
    vault.upsertProfile('codex', { name: 'x', accountId: 'acct-x', createdAt: 1 })
    vault.saveSecret('codex', 'x', JSON.stringify({ tokens: { access_token: jwt, account_id: 'acct-x' } }))
    expect(await credentialFor('codex', 'x')).toEqual({ authorization: `Bearer ${jwt}`, extraHeaders: { 'chatgpt-account-id': 'acct-x' }, expiresAt: exp * 1000 })

    const expiresAt = Date.now() + 7_200_000
    vault.upsertProfile('claude-code', { name: 'y', accountId: 'acct-y', createdAt: 1 })
    vault.saveSecret('claude-code', 'y', JSON.stringify({ keychain: JSON.stringify({ claudeAiOauth: { accessToken: 'TOK-y', expiresAt } }) }))
    expect(await credentialFor('claude', 'y')).toEqual({ authorization: 'Bearer TOK-y', expiresAt })
  })
})

describe('control options', () => {
  it('a gateway in its own process answers with its host pid and the host usage poll', async () => {
    cleanup = tempCore().cleanup
    const polls: string[] = []
    server = createServer(
      (req, res) =>
        void handleControl(req, res, 'temp-code', {
          pid: 4242,
          usage: async (serviceId, force) => {
            polls.push(`${serviceId}:${force}`)
            return [{ profileName: 'A', windows: [] }]
          }
        })
    )
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    expect(await (await fetch(`${base}/__aliax`)).json()).toMatchObject({ ok: true, pid: 4242, owner: 'temp-code' })
    expect(await (await fetch(`${base}/claude/__aliax/usage?service=claude-code&force=1`)).json()).toEqual({ reports: [{ profileName: 'A', windows: [] }] })
    expect(polls).toEqual(['claude-code:true'])
  })
})
