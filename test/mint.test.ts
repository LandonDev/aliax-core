import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkMinted, exchangeCodeForStatic, mintStaticFromRefresh, parseTokenResponse, STATIC_MIN_LIFETIME_MS, staticRenewalDue, staticTokenOf, TokenEndpointError } from '../src/mint'
import { CLAUDE_TOKEN_URL, ONE_YEAR_S } from '../src/oauth'
import { hasRefresh, isStaticBlob } from '../src/sync'
import * as vault from '../src/vault'
import { jsonResponse, tempCore } from './helpers'

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})
const core = (overrides: Parameters<typeof tempCore>[0] = {}): void => {
  cleanups.push(tempCore(overrides).cleanup)
}

const NOW = 1_800_000_000_000
const DAY = 86_400_000
const grantBlob = (refresh = 'R1', scopes = ['org:create_api_key', 'user:profile', 'user:inference']): string =>
  JSON.stringify({
    keychain: JSON.stringify({ claudeAiOauth: { accessToken: 'A1', refreshToken: refresh, expiresAt: NOW + 3_600_000, scopes } }),
    oauthAccount: { accountUuid: 'u1', emailAddress: 'one@x.test' },
    appSession: [{ name: 'sessionKey', value: 'sk-ant-sid01-x', domain: '.claude.ai', path: '/', secure: true, httpOnly: true }]
  })
const answer = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  token_type: 'Bearer',
  access_token: 'sk-ant-oat01-year',
  refresh_token: 'R2',
  expires_in: ONE_YEAR_S,
  scope: 'user:profile user:inference',
  account: { uuid: 'u1', email_address: 'one@x.test' },
  organization: { uuid: 'org1', name: 'One' },
  ...over
})
const tokensOf = (blob: string): Record<string, unknown> => JSON.parse(JSON.parse(blob).keychain).claudeAiOauth

/** A token endpoint that answers from a script, one entry per POST, and records every body. */
function endpoint(script: ((body: Record<string, unknown>) => Response | Record<string, unknown>)[]) {
  const bodies: Record<string, unknown>[] = []
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url !== CLAUDE_TOKEN_URL) throw new Error(`unexpected fetch ${url}`)
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    bodies.push(body)
    const next = script.shift()
    if (!next) throw new Error('token endpoint asked more than scripted')
    const out = next(body)
    return out instanceof Response ? out : jsonResponse(out)
  })
  return { fetch, bodies }
}

describe('parseTokenResponse', () => {
  it('reads the token, its life, its scopes and the account the server names', () => {
    const m = parseTokenResponse(answer(), NOW)!
    expect(m).toMatchObject({ accessToken: 'sk-ant-oat01-year', refreshToken: 'R2', expiresInS: ONE_YEAR_S, scopes: ['user:profile', 'user:inference'] })
    expect(m.expiresAt).toBe(NOW + ONE_YEAR_S * 1000)
    expect(m.account).toEqual({ uuid: 'u1', email: 'one@x.test' })
    expect(m.organization).toEqual({ uuid: 'org1', name: 'One' })
  })
  it('a code exchange made for a static token carries no refresh token, and the profile shape of the email is read too', () => {
    const m = parseTokenResponse(answer({ refresh_token: undefined, account: { uuid: 'u1', email: 'one@x.test' } }), NOW)!
    expect(m.refreshToken).toBeNull()
    expect(m.account).toEqual({ uuid: 'u1', email: 'one@x.test' })
  })
  it('refuses answers with no token or no life', () => {
    expect(parseTokenResponse(null, NOW)).toBeNull()
    expect(parseTokenResponse({ access_token: '' }, NOW)).toBeNull()
    expect(parseTokenResponse({ access_token: 'x' }, NOW)).toBeNull()
    expect(parseTokenResponse({ access_token: 'x', expires_in: 'soon' }, NOW)).toBeNull()
    expect(parseTokenResponse(answer({ account: {} }), NOW)!.account).toBeNull()
  })
})

describe('checkMinted', () => {
  const minted = parseTokenResponse(answer(), NOW)!
  it('a year for the right account passes, by id or by the email a row was made from', () => {
    expect(checkMinted(minted, { accountId: 'u1' }, { now: NOW })).toEqual({ ok: true })
    expect(checkMinted(minted, { email: 'One@X.test' }, { now: NOW })).toEqual({ ok: true })
    expect(checkMinted(minted, { accountId: 'one@x.test' }, { now: NOW })).toEqual({ ok: true })
  })
  it('a short life is refused as short-lived, even for the right account', () => {
    const short = parseTokenResponse(answer({ expires_in: 8 * 3600 }), NOW)!
    expect(checkMinted(short, { accountId: 'u1' }, { now: NOW })).toMatchObject({ ok: false, reason: 'short-lived' })
    expect(STATIC_MIN_LIFETIME_MS).toBe(300 * DAY)
    const justEnough = parseTokenResponse(answer({ expires_in: 301 * 86_400 }), NOW)!
    expect(checkMinted(justEnough, { accountId: 'u1' }, { now: NOW })).toEqual({ ok: true })
  })
  it('another account is refused by name, and an unnamed token only passes when the caller proved the identity', () => {
    expect(checkMinted(minted, { accountId: 'u2', email: 'two@x.test' }, { now: NOW })).toEqual({ ok: false, reason: 'wrong-account', detail: 'the token belongs to one@x.test, not two@x.test' })
    const unnamed = parseTokenResponse(answer({ account: undefined }), NOW)!
    expect(checkMinted(unnamed, { accountId: 'u1' }, { now: NOW })).toMatchObject({ ok: false, reason: 'no-account' })
    expect(checkMinted(unnamed, { accountId: 'u1' }, { now: NOW, allowUnnamed: true })).toEqual({ ok: true })
  })
  it('staticTokenOf files under the account the server named, falling back to the row', () => {
    expect(staticTokenOf(minted, { accountId: 'row', email: 'row@x' })).toMatchObject({ token: 'sk-ant-oat01-year', accountId: 'u1', email: 'one@x.test', scopes: ['user:profile', 'user:inference'], organizationUuid: 'org1', organizationName: 'One' })
    const unnamed = parseTokenResponse(answer({ account: undefined, scope: undefined }), NOW)!
    expect(staticTokenOf(unnamed, { accountId: 'row', email: 'row@x' })).toMatchObject({ accountId: 'row', email: 'row@x', scopes: undefined })
    expect(() => staticTokenOf(unnamed, {})).toThrow(/no account/)
  })
  it('staticRenewalDue starts 30 days out', () => {
    expect(staticRenewalDue(NOW + 31 * DAY, NOW)).toBe(false)
    expect(staticRenewalDue(NOW + 30 * DAY, NOW)).toBe(true)
    expect(staticRenewalDue(NOW - DAY, NOW)).toBe(true)
    expect(staticRenewalDue(undefined, NOW)).toBe(false)
  })
})

describe('exchangeCodeForStatic', () => {
  it('posts the ordinary code exchange plus expires_in for a year', async () => {
    const { fetch, bodies } = endpoint([() => answer({ refresh_token: undefined })])
    core({ fetch })
    const m = await exchangeCodeForStatic({ code: 'c', state: 's', verifier: 'v', redirectUri: 'https://platform.claude.com/oauth/code/callback' }, { now: () => NOW })
    expect(bodies[0]).toEqual({ grant_type: 'authorization_code', code: 'c', state: 's', client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e', redirect_uri: 'https://platform.claude.com/oauth/code/callback', code_verifier: 'v', expires_in: ONE_YEAR_S })
    expect(m.expiresAt).toBe(NOW + ONE_YEAR_S * 1000)
  })
  it('an endpoint refusal is thrown with its status and error code', async () => {
    const { fetch } = endpoint([() => jsonResponse({ error: 'invalid_grant', error_description: 'code used' }, { status: 400 })])
    core({ fetch })
    const err = await exchangeCodeForStatic({ code: 'c', state: 's', verifier: 'v', redirectUri: 'r' }).catch((e) => e as TokenEndpointError)
    expect(err).toBeInstanceOf(TokenEndpointError)
    expect(err).toMatchObject({ status: 400, code: 'invalid_grant', message: 'token endpoint answered 400 (code used)' })
  })
})

describe('mintStaticFromRefresh', () => {
  const seed = (blob = grantBlob()): void => {
    vault.upsertProfile('claude-code', { name: 'one', accountId: 'u1', email: 'one@x.test', createdAt: NOW })
    vault.saveSecret('claude-code', 'one', blob)
  }

  it('presents the grant with the static scopes and a one-year expires_in, files the static token and drops the grant', async () => {
    const { fetch, bodies } = endpoint([() => answer()])
    core({ fetch, environmentId: 'env_me' })
    seed()
    const out = await mintStaticFromRefresh('one', { now: () => NOW })
    expect(out).toEqual({ ok: true, name: 'one', minted: { expiresAt: NOW + ONE_YEAR_S * 1000, scopes: ['user:profile', 'user:inference'], account: { uuid: 'u1', email: 'one@x.test' } } })
    expect(bodies).toEqual([{ grant_type: 'refresh_token', refresh_token: 'R1', client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e', scope: 'user:profile user:inference', expires_in: ONE_YEAR_S }])
    const blob = vault.readSecret('claude-code', 'one')!
    expect(isStaticBlob(blob)).toBe(true)
    expect(hasRefresh('claude-code', blob)).toBe(false)
    expect(tokensOf(blob)).toEqual({ accessToken: 'sk-ant-oat01-year', expiresAt: NOW + ONE_YEAR_S * 1000, scopes: ['user:profile', 'user:inference'] })
    // The row keeps its identity and its claude.ai session; the row says static with no owner.
    expect(JSON.parse(blob).appSession).toHaveLength(1)
    expect(JSON.parse(blob).oauthAccount).toEqual({ accountUuid: 'u1', emailAddress: 'one@x.test' })
    expect(vault.profiles('claude-code')[0]).toMatchObject({ name: 'one', static: true, accountId: 'u1' })
    expect(vault.profiles('claude-code')[0].owner).toBeUndefined()
  })

  it('a short life for the profile scopes asks again with user:inference alone, presenting the ROTATED grant', async () => {
    const { fetch, bodies } = endpoint([() => answer({ expires_in: 8 * 3600, refresh_token: 'R2' }), () => answer({ refresh_token: 'R3', scope: 'user:inference' })])
    core({ fetch, environmentId: 'env_me' })
    seed()
    const out = await mintStaticFromRefresh('one', { now: () => NOW })
    expect(out).toMatchObject({ ok: true, minted: { scopes: ['user:inference'] } })
    expect(bodies.map((b) => [b.refresh_token, b.scope])).toEqual([['R1', 'user:profile user:inference'], ['R2', 'user:inference']])
    expect(tokensOf(vault.readSecret('claude-code', 'one')!).scopes).toEqual(['user:inference'])
  })

  it('a year refused twice leaves the account a healthy owned profile holding the latest rotated grant', async () => {
    const { fetch } = endpoint([() => answer({ expires_in: 3600, refresh_token: 'R2' }), () => answer({ expires_in: 3600, refresh_token: 'R3', scope: 'user:inference' })])
    core({ fetch, environmentId: 'env_me' })
    seed()
    const out = await mintStaticFromRefresh('one', { now: () => NOW })
    expect(out).toMatchObject({ ok: false, reason: 'short-lived' })
    const blob = vault.readSecret('claude-code', 'one')!
    expect(isStaticBlob(blob)).toBe(false)
    expect(tokensOf(blob)).toMatchObject({ accessToken: 'sk-ant-oat01-year', refreshToken: 'R3', expiresAt: NOW + 3_600_000, scopes: ['org:create_api_key', 'user:profile', 'user:inference'] })
    expect(vault.profiles('claude-code')[0].static).toBeFalsy()
  })

  it('a token for another account is refused by name and never filed; the rotated grant is kept', async () => {
    const { fetch } = endpoint([() => answer({ account: { uuid: 'u9', email_address: 'nine@x.test' }, refresh_token: 'R2' })])
    core({ fetch, environmentId: 'env_me' })
    seed()
    const out = await mintStaticFromRefresh('one', { now: () => NOW })
    expect(out).toEqual({ ok: false, reason: 'wrong-account', detail: 'the token belongs to nine@x.test, not one@x.test' })
    expect(isStaticBlob(vault.readSecret('claude-code', 'one')!)).toBe(false)
    expect(tokensOf(vault.readSecret('claude-code', 'one')!).refreshToken).toBe('R2')
    expect(vault.profiles('claude-code')).toHaveLength(1)
  })

  it('a grant issued without user:profile asks for user:inference alone from the start', async () => {
    const { fetch, bodies } = endpoint([() => answer({ scope: 'user:inference' })])
    core({ fetch, environmentId: 'env_me' })
    seed(grantBlob('R1', ['user:inference']))
    expect(await mintStaticFromRefresh('one', { now: () => NOW })).toMatchObject({ ok: true })
    expect(bodies.map((b) => b.scope)).toEqual(['user:inference'])
  })

  it('an endpoint refusal ends the attempt with the grant as it was; invalid_scope asks for less', async () => {
    const { fetch, bodies } = endpoint([() => jsonResponse({ error: 'invalid_scope' }, { status: 400 }), () => answer({ scope: 'user:inference' })])
    core({ fetch, environmentId: 'env_me' })
    seed()
    expect(await mintStaticFromRefresh('one', { now: () => NOW })).toMatchObject({ ok: true, minted: { scopes: ['user:inference'] } })
    expect(bodies.map((b) => [b.refresh_token, b.scope])).toEqual([['R1', 'user:profile user:inference'], ['R1', 'user:inference']])
    cleanups.pop()!()
    const refused = endpoint([() => jsonResponse({ error: 'invalid_grant' }, { status: 400 })])
    core({ fetch: refused.fetch, environmentId: 'env_me' })
    seed()
    expect(await mintStaticFromRefresh('one', { now: () => NOW })).toEqual({ ok: false, reason: 'endpoint', detail: 'token endpoint answered 400 (invalid_grant)' })
    expect(tokensOf(vault.readSecret('claude-code', 'one')!).refreshToken).toBe('R1')
  })

  it('nothing is presented for a static profile, a copy owned elsewhere or a row with no refresh token', async () => {
    const { fetch } = endpoint([])
    core({ fetch, environmentId: 'env_me' })
    seed()
    vault.upsertProfile('claude-code', { ...vault.profiles('claude-code')[0], owner: 'env_other' })
    expect(await mintStaticFromRefresh('one')).toEqual({ ok: false, reason: 'no-grant', detail: 'the grant is refreshed by env_other' })
    vault.upsertProfile('claude-code', { ...vault.profiles('claude-code')[0], owner: undefined, static: true })
    expect(await mintStaticFromRefresh('one')).toMatchObject({ ok: false, reason: 'no-grant', detail: 'a one-year token holds no grant to mint from' })
    vault.upsertProfile('claude-code', { ...vault.profiles('claude-code')[0], static: false })
    vault.saveSecret('claude-code', 'one', JSON.stringify({ keychain: JSON.stringify({ claudeAiOauth: { accessToken: 'A1', expiresAt: NOW + 3_600_000 } }), oauthAccount: { accountUuid: 'u1' } }))
    expect(await mintStaticFromRefresh('one')).toEqual({ ok: false, reason: 'no-grant', detail: 'no refresh token on file' })
    expect(await mintStaticFromRefresh('nobody')).toEqual({ ok: false, reason: 'no-grant', detail: 'no account named nobody' })
    expect(fetch).not.toHaveBeenCalled()
  })
})
