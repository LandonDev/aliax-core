import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_TOKEN_URL, OPENAI_TOKEN_URL } from '../src/oauth'
import { refreshClaude, refreshCodex, refreshFor } from '../src/refresh'
import { applyTransfer, hasRefresh, stripRefresh, type Transfer } from '../src/sync'
import * as vault from '../src/vault'
import { jsonResponse, tempCore } from './helpers'

let cleanup = (): void => {}
afterEach(() => cleanup())

const HOUR = 3_600_000
const claudeBlob = (exp: number, refresh: string | null = `R${exp}`): string =>
  JSON.stringify({ keychain: JSON.stringify({ claudeAiOauth: { accessToken: `T${exp}`, ...(refresh ? { refreshToken: refresh } : {}), expiresAt: exp } }), oauthAccount: { accountUuid: 'u' } })
const jwt = (exp: number): string => `h.${Buffer.from(JSON.stringify({ exp: Math.floor(exp / 1000) })).toString('base64url')}.s`
const codexBlob = (exp: number, refresh: string | null = 'CR'): string =>
  JSON.stringify({ tokens: { access_token: jwt(exp), ...(refresh ? { refresh_token: refresh } : {}), id_token: 'id', account_id: 'acct' }, last_refresh: 'then' })
const tokensOf = (b: string | null): Record<string, unknown> => JSON.parse(JSON.parse(b!).keychain).claudeAiOauth

const refusingFetch = vi.fn(async (url: string) => {
  throw new Error(`a consumer must never call ${url}`)
})

describe('refresh rules by ownership', () => {
  it('a copy owned by another environment asks that owner and never the token endpoint', async () => {
    const stale = claudeBlob(Date.now() - 1000, null)
    const fresh = claudeBlob(Date.now() + HOUR, null)
    const askOwner = vi.fn(async (service: string, name: string, owner: string) => {
      // The host lands the owner's answer the way temp-code does, then hands back what the vault holds.
      const t: Transfer = { service: 'claude-code', mode: 'access', profile: { name, accountId: 'u', createdAt: 1, static: false, owner }, blob: fresh, expiresAt: Date.now() + HOUR }
      expect(service).toBe('claude-code')
      const out = applyTransfer(t)
      expect(out).toMatchObject({ ok: true, saved: true })
      return vault.readSecret('claude-code', name)
    })
    ;({ cleanup } = tempCore({ fetch: refusingFetch, environmentId: 'env_mac', hooks: { askOwner } }))
    vault.upsertProfile('claude-code', { name: 'p', accountId: 'u', createdAt: 1, owner: 'env_box' })
    vault.saveSecret('claude-code', 'p', stale)
    const out = await refreshClaude('p', stale)
    expect(askOwner).toHaveBeenCalledWith('claude-code', 'p', 'env_box')
    expect(refusingFetch).not.toHaveBeenCalled()
    expect(tokensOf(out)).toMatchObject({ accessToken: tokensOf(fresh).accessToken })
    expect(hasRefresh('claude-code', out!)).toBe(false)
  })

  it('a consumer with no way to reach its owner renews nothing and makes no call', async () => {
    ;({ cleanup } = tempCore({ fetch: refusingFetch, environmentId: 'env_mac' }))
    vault.upsertProfile('claude-code', { name: 'p', accountId: 'u', createdAt: 1, owner: 'env_box' })
    vault.saveSecret('claude-code', 'p', claudeBlob(Date.now() - 1000, null))
    expect(await refreshClaude('p', claudeBlob(Date.now() - 1000, null))).toBeNull()
    vault.upsertProfile('codex', { name: 'c', accountId: 'acct', createdAt: 1, owner: 'env_box' })
    vault.saveSecret('codex', 'c', codexBlob(Date.now() - 1000, null))
    expect(await refreshCodex('c', codexBlob(Date.now() - 1000, null))).toBeNull()
    expect(refusingFetch).not.toHaveBeenCalled()
  })

  it('a static token is never renewed, by anyone', async () => {
    ;({ cleanup } = tempCore({ fetch: refusingFetch, environmentId: 'env_mac', hooks: { askOwner: vi.fn(async () => null) } }))
    vault.upsertProfile('claude-code', { name: 's', accountId: 'u', createdAt: 1, static: true })
    const blob = JSON.stringify({ keychain: JSON.stringify({ claudeAiOauth: { accessToken: 'OAT', expiresAt: Date.now() - 1 } }), oauthAccount: {}, tokenKind: 'static' })
    vault.saveSecret('claude-code', 's', blob)
    expect(await refreshClaude('s', blob)).toBeNull()
    expect(refusingFetch).not.toHaveBeenCalled()
  })

  it('the owner of a Codex grant renews with the VAULT\'s refresh token, under the lock, never backwards', async () => {
    const presented: string[] = []
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url !== OPENAI_TOKEN_URL) throw new Error(`unexpected fetch ${url}`)
      presented.push(JSON.parse(init!.body as string).refresh_token)
      await new Promise((r) => setTimeout(r, 5))
      return jsonResponse({ access_token: jwt(Date.now() + 10 * 86_400_000), refresh_token: 'CR-NEW', id_token: 'id2' })
    })
    ;({ cleanup } = tempCore({ fetch, environmentId: 'env_box' }))
    vault.upsertProfile('codex', { name: 'c', accountId: 'acct', createdAt: 1, owner: 'env_box' })
    const stale = codexBlob(Date.now() - 1000, 'CR-OLD')
    vault.saveSecret('codex', 'c', codexBlob(Date.now() - 500, 'CR-VAULT'))
    const [a, b] = await Promise.all([refreshCodex('c', stale), refreshCodex('c', stale)])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(presented).toEqual(['CR-VAULT'])
    expect(a).toBe(b)
    expect(JSON.parse(a!).tokens).toMatchObject({ refresh_token: 'CR-NEW', id_token: 'id2', account_id: 'acct' })
    expect(vault.readSecret('codex', 'c')).toBe(a)
    // A vault copy fresher than the caller's, outside the margin, comes back with no POST.
    const fresher = codexBlob(Date.now() + 5 * 86_400_000, 'CR-F')
    vault.saveSecret('codex', 'c', fresher)
    expect(await refreshCodex('c', stale)).toBe(fresher)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('a Claude owner still renews at the endpoint, and a legacy profile with no owner counts as this machine\'s', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url !== CLAUDE_TOKEN_URL) throw new Error(`unexpected fetch ${url}`)
      return jsonResponse({ access_token: 'NEW', refresh_token: 'R-NEW', expires_in: 3600 })
    })
    ;({ cleanup } = tempCore({ fetch, environmentId: 'env_mac' }))
    vault.upsertProfile('claude-code', { name: 'legacy', accountId: 'u', createdAt: 1 })
    vault.saveSecret('claude-code', 'legacy', claudeBlob(Date.now() - 1000))
    expect(tokensOf(await refreshClaude('legacy', claudeBlob(Date.now() - 1000)))).toMatchObject({ accessToken: 'NEW' })
    vault.upsertProfile('claude-code', { name: 'mine', accountId: 'u2', createdAt: 1, owner: 'env_mac' })
    vault.saveSecret('claude-code', 'mine', claudeBlob(Date.now() - 1000))
    expect(tokensOf(await refreshClaude('mine', claudeBlob(Date.now() - 1000)))).toMatchObject({ accessToken: 'NEW' })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('refreshFor hands adapters a renewer only on the gateway owner, per service', () => {
    ;({ cleanup } = tempCore({ fetch: refusingFetch, role: () => 'standby' }))
    expect(refreshFor('claude-code', 'p')).toBeNull()
    expect(refreshFor('codex', 'p')).toBeNull()
    cleanup()
    ;({ cleanup } = tempCore({ fetch: refusingFetch, role: () => 'owner' }))
    expect(typeof refreshFor('claude-code', 'p')).toBe('function')
    expect(typeof refreshFor('codex', 'p')).toBe('function')
    expect(refreshFor('cursor', 'p')).toBeNull()
  })

  it('stripRefresh is what a consumer keeps after asking', () => {
    ;({ cleanup } = tempCore({ fetch: refusingFetch }))
    expect(hasRefresh('codex', stripRefresh('codex', codexBlob(Date.now())))).toBe(false)
  })
})
