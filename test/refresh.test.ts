import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLAUDE_TOKEN_URL } from '../src/oauth'
import { EXPIRY_MARGIN_MS, once, refreshClaude } from '../src/refresh'
import * as vault from '../src/vault'
import { jsonResponse, tempCore } from './helpers'

let cleanup = (): void => {}
afterEach(() => cleanup())

const blob = (exp: number, refresh = `R${exp}`, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ keychain: JSON.stringify({ claudeAiOauth: { accessToken: `T${exp}`, refreshToken: refresh, expiresAt: exp } }), oauthAccount: { accountUuid: 'u' }, ...extra })
const tokensOf = (b: string | null): { accessToken: string; refreshToken: string; expiresAt: number } => JSON.parse(JSON.parse(b!).keychain).claudeAiOauth

/** A token endpoint that answers after a tick, recording every refresh token it was shown. */
function tokenServer(expiresIn = 3600): { fetch: ReturnType<typeof vi.fn>; presented: string[] } {
  const presented: string[] = []
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url !== CLAUDE_TOKEN_URL) throw new Error(`unexpected fetch ${url}`)
    presented.push(JSON.parse(init!.body as string).refresh_token)
    await new Promise((r) => setTimeout(r, 5))
    return jsonResponse({ access_token: 'NEW', refresh_token: 'R-NEW', expires_in: expiresIn })
  })
  return { fetch, presented }
}

describe('once', () => {
  it('joins a second caller onto the first run and hands it the same result', async () => {
    let runs = 0
    const work = async (): Promise<number> => {
      runs++
      await new Promise((r) => setTimeout(r, 5))
      return runs
    }
    const [a, b] = await Promise.all([once('codex', 'x', work), once('codex', 'x', work)])
    expect([a, b, runs]).toEqual([1, 1, 1])
    expect(await once('codex', 'x', work)).toBe(2)
    expect(await once('codex', 'y', work)).toBe(3)
  })
})

describe('refreshClaude', () => {
  it('two concurrent refreshes of one profile make one POST and both get the new blob', async () => {
    const { fetch, presented } = tokenServer()
    ;({ cleanup } = tempCore({ fetch }))
    const stale = blob(Date.now() - 1000, 'R-VAULT', { appSession: [{ name: 'sessionKey', value: 'sk' }] })
    vault.saveSecret('claude-code', 'p', stale)
    const [a, b] = await Promise.all([refreshClaude('p', stale), refreshClaude('p', stale)])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(presented).toEqual(['R-VAULT'])
    expect(a).toBe(b)
    expect(tokensOf(a)).toMatchObject({ accessToken: 'NEW', refreshToken: 'R-NEW' })
    expect(tokensOf(a).expiresAt).toBeGreaterThan(Date.now() + 3_500_000)
    // Everything else in the stored blob survives.
    expect(JSON.parse(a!)).toMatchObject({ oauthAccount: { accountUuid: 'u' }, appSession: [{ name: 'sessionKey', value: 'sk' }] })
    expect(vault.readSecret('claude-code', 'p')).toBe(a)
  })

  it('a caller holding a blob older than a fresh vault copy gets the vault copy with no POST', async () => {
    const { fetch } = tokenServer()
    ;({ cleanup } = tempCore({ fetch }))
    const fresh = blob(Date.now() + 2 * 3_600_000)
    vault.saveSecret('claude-code', 'p', fresh)
    expect(await refreshClaude('p', blob(Date.now() - 1000))).toBe(fresh)
    expect(fetch).not.toHaveBeenCalled()
    // A vault copy inside the margin is renewed, with ITS refresh token, not the caller's.
    const nearly = blob(Date.now() + EXPIRY_MARGIN_MS / 2, 'R-VAULT')
    vault.saveSecret('claude-code', 'p', nearly)
    const out = await refreshClaude('p', blob(Date.now() - 1000, 'R-OLD'))
    expect(tokensOf(out).accessToken).toBe('NEW')
    expect(JSON.parse(fetch.mock.calls[0][1].body).refresh_token).toBe('R-VAULT')
  })

  it('never writes a blob whose expiry is older than the vault\'s, and returns null when the POST fails', async () => {
    const { fetch } = tokenServer(1)
    ;({ cleanup } = tempCore({ fetch }))
    const current = blob(Date.now() + 2 * 3_600_000)
    vault.saveSecret('claude-code', 'p', current)
    // Same blob as the vault, so no short-circuit: the POST runs but answers with a shorter-lived token.
    expect(await refreshClaude('p', current)).toBe(current)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(vault.readSecret('claude-code', 'p')).toBe(current)
    // A refused POST, or a blob with no refresh token, yields null and leaves the vault alone.
    const stale = blob(Date.now() - 1000)
    vault.saveSecret('claude-code', 'p', stale)
    fetch.mockResolvedValueOnce(new Response('nope', { status: 400 }))
    expect(await refreshClaude('p', stale)).toBeNull()
    expect(vault.readSecret('claude-code', 'p')).toBe(stale)
    vault.saveSecret('claude-code', 'p', JSON.stringify({ appSession: [] }))
    expect(await refreshClaude('p', JSON.stringify({ appSession: [] }))).toBeNull()
  })
})
