import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_TOKEN_URL, OPENAI_TOKEN_URL } from '../src/oauth'
import { acquire } from '../src/lock'
import { refreshClaude, refreshCodex, refreshFor } from '../src/refresh'
import { applyTransfer, beginHandoff, hasRefresh, refreshFingerprint, stripRefresh, type Transfer } from '../src/sync'
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
      const out = applyTransfer(t, owner, 'peer')
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

  it('a refresh in flight when a handoff begins finishes first, so the handoff carries the rotated token', async () => {
    let answer: (() => void) | null = null
    const fetch = vi.fn(async (url: string) => {
      if (url !== CLAUDE_TOKEN_URL) throw new Error(`unexpected fetch ${url}`)
      await new Promise<void>((r) => (answer = r))
      return jsonResponse({ access_token: 'T-ROTATED', refresh_token: 'R-ROTATED', expires_in: 3600 })
    })
    const askOwner = vi.fn(async () => null)
    ;({ cleanup } = tempCore({ fetch, environmentId: 'env_mac', hooks: { askOwner } }))
    vault.upsertProfile('claude-code', { name: 'p', accountId: 'u', createdAt: 1 })
    vault.saveSecret('claude-code', 'p', claudeBlob(Date.now() - 1000, 'R-OLD'))
    const refreshing = refreshClaude('p', claudeBlob(Date.now() - 1000, 'R-OLD'))
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    let handoff: Awaited<ReturnType<typeof beginHandoff>> | null = null
    const starting = beginHandoff('claude-code', 'p', 'env_box').then((h) => (handoff = h))
    await new Promise((r) => setTimeout(r, 10))
    // The export waits: the vault still holds R-OLD, which the answer is about to revoke.
    expect(handoff).toBeNull()
    answer!()
    expect(tokensOf(await refreshing)).toMatchObject({ accessToken: 'T-ROTATED', refreshToken: 'R-ROTATED' })
    await starting
    expect(tokensOf(handoff!.transfer.blob)).toMatchObject({ refreshToken: 'R-ROTATED' })
    expect(handoff!.fingerprint).toBe(refreshFingerprint('claude-code', handoff!.transfer.blob))
    // While the handoff is open no refresh starts; once it commits, the former owner serves its stripped copy
    // (still fresh) and never the endpoint again; past the margin it would ask env_box.
    const during = refreshClaude('p', claudeBlob(Date.now() - 1000, 'R-ROTATED'))
    await new Promise((r) => setTimeout(r, 10))
    expect(fetch).toHaveBeenCalledTimes(1)
    handoff!.commit()
    const served = await during
    expect(tokensOf(served)).toMatchObject({ accessToken: 'T-ROTATED' })
    expect(hasRefresh('claude-code', served!)).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(askOwner).not.toHaveBeenCalled()
    expect(hasRefresh('claude-code', vault.readSecret('claude-code', 'p')!)).toBe(false)
    expect(vault.profiles('claude-code')[0]).toMatchObject({ owner: 'env_box' })
  })

  it('a refresh that finds ownership gone when the endpoint answers never writes the refresh token back', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url !== CLAUDE_TOKEN_URL) throw new Error(`unexpected fetch ${url}`)
      // Ownership moves while the request is out, past the lock (a path the lock does not cover).
      vault.upsertProfile('claude-code', { name: 'p', accountId: 'u', createdAt: 1, owner: 'env_box' })
      vault.saveSecret('claude-code', 'p', claudeBlob(Date.now() - 500, null), 'sync')
      return jsonResponse({ access_token: 'T-NEW', refresh_token: 'R-NEW', expires_in: 3600 })
    })
    ;({ cleanup } = tempCore({ fetch, environmentId: 'env_mac' }))
    vault.upsertProfile('claude-code', { name: 'p', accountId: 'u', createdAt: 1 })
    vault.saveSecret('claude-code', 'p', claudeBlob(Date.now() - 1000, 'R-OLD'))
    const out = await refreshClaude('p', claudeBlob(Date.now() - 1000, 'R-OLD'))
    // The caller gets the fresh access token for this one request, stripped; the vault stays as the sync left it.
    expect(tokensOf(out)).toMatchObject({ accessToken: 'T-NEW' })
    expect(hasRefresh('claude-code', out!)).toBe(false)
    const stored = vault.readSecret('claude-code', 'p')!
    expect(hasRefresh('claude-code', stored)).toBe(false)
    expect(tokensOf(stored).accessToken).toMatch(/^T\d+$/)
    // The same for Codex.
    const codexFetch = vi.fn(async (url: string) => {
      if (url !== OPENAI_TOKEN_URL) throw new Error(`unexpected fetch ${url}`)
      vault.upsertProfile('codex', { name: 'c', accountId: 'acct', createdAt: 1, owner: 'env_box' })
      vault.saveSecret('codex', 'c', codexBlob(Date.now() - 500, null), 'sync')
      return jsonResponse({ access_token: jwt(Date.now() + HOUR), refresh_token: 'CR-NEW', id_token: 'id2' })
    })
    ;({ cleanup } = tempCore({ fetch: codexFetch, environmentId: 'env_mac' }))
    vault.upsertProfile('codex', { name: 'c', accountId: 'acct', createdAt: 1 })
    vault.saveSecret('codex', 'c', codexBlob(Date.now() - 1000, 'CR-OLD'))
    const codexOut = await refreshCodex('c', codexBlob(Date.now() - 1000, 'CR-OLD'))
    expect(hasRefresh('codex', codexOut!)).toBe(false)
    expect(hasRefresh('codex', vault.readSecret('codex', 'c')!)).toBe(false)
    expect(JSON.parse(vault.readSecret('codex', 'c')!).tokens.access_token).toBe(jwt(Date.now() - 500))
  })

  it('two refreshers of one profile share a result and a held lock delays both', async () => {
    const fetch = vi.fn(async () => jsonResponse({ access_token: 'T-NEW', refresh_token: 'R-NEW', expires_in: 3600 }))
    ;({ cleanup } = tempCore({ fetch, environmentId: 'env_mac' }))
    vault.upsertProfile('claude-code', { name: 'p', accountId: 'u', createdAt: 1 })
    vault.saveSecret('claude-code', 'p', claudeBlob(Date.now() - 1000, 'R-OLD'))
    const release = await acquire('claude-code', 'p')
    const a = refreshClaude('p', claudeBlob(Date.now() - 1000, 'R-OLD'))
    const b = refreshClaude('p', claudeBlob(Date.now() - 1000, 'R-OLD'))
    await new Promise((r) => setTimeout(r, 10))
    expect(fetch).not.toHaveBeenCalled()
    release()
    expect(await a).toBe(await b)
    expect(fetch).toHaveBeenCalledTimes(1)
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
