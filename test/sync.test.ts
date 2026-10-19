import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SaveOrigin } from '../src/config'
import * as sync from '../src/sync'
import * as vault from '../src/vault'
import { tempCore } from './helpers'

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
})
const core = (overrides: Parameters<typeof tempCore>[0] = {}): string => {
  const { dataDir, cleanup } = tempCore(overrides)
  cleanups.push(cleanup)
  return dataDir
}

const claudeBlob = (exp: number, refresh: string | null = `R${exp}`, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({
    keychain: JSON.stringify({ claudeAiOauth: { accessToken: `T${exp}`, ...(refresh ? { refreshToken: refresh } : {}), expiresAt: exp } }),
    oauthAccount: { accountUuid: 'u1', emailAddress: 'a@x' },
    ...extra
  })
const jwt = (exp: number): string => `h.${Buffer.from(JSON.stringify({ exp: Math.floor(exp / 1000), sub: 's' })).toString('base64url')}.s`
const codexBlob = (exp: number, refresh: string | null = 'CR'): string =>
  JSON.stringify({ tokens: { access_token: jwt(exp), ...(refresh ? { refresh_token: refresh } : {}), id_token: 'id', account_id: 'acct' }, last_refresh: 'now' })
const cursorBlob = (exp: number): string => JSON.stringify({ access: jwt(exp), refresh: 'CUR', vscdb: {} })
const tokensOf = (blob: string): Record<string, unknown> => JSON.parse(JSON.parse(blob).keychain).claudeAiOauth
const sec = (ms: number): number => Math.floor(ms / 1000) * 1000

const HOUR = 3_600_000
const later = Date.now() + 2 * HOUR
const earlier = Date.now() + HOUR

describe('blob helpers', () => {
  it('reads the access expiry of every service and nothing from garbage', () => {
    core()
    expect(sync.accessExpiry('claude-code', claudeBlob(later))).toBe(later)
    expect(sync.accessExpiry('codex', codexBlob(later))).toBe(sec(later))
    expect(sync.accessExpiry('cursor', cursorBlob(later))).toBe(sec(later))
    expect(sync.accessExpiry('claude-code', 'nope')).toBeNull()
    expect(sync.accessExpiry('codex', JSON.stringify({ OPENAI_API_KEY: 'k' }))).toBeNull()
  })

  it('strips the refresh token of every service and keeps the rest', () => {
    core()
    const claude = sync.stripRefresh('claude-code', claudeBlob(later, 'R', { appSession: [{ name: 'sessionKey' }] }))
    expect(sync.hasRefresh('claude-code', claude)).toBe(false)
    expect(tokensOf(claude)).toEqual({ accessToken: `T${later}`, expiresAt: later })
    expect(JSON.parse(claude)).toMatchObject({ oauthAccount: { accountUuid: 'u1' }, appSession: [{ name: 'sessionKey' }] })
    const codex = sync.stripRefresh('codex', codexBlob(later))
    expect(sync.hasRefresh('codex', codex)).toBe(false)
    expect(JSON.parse(codex).tokens).toEqual({ access_token: jwt(later), id_token: 'id', account_id: 'acct' })
    const cursor = sync.stripRefresh('cursor', cursorBlob(later))
    expect(sync.hasRefresh('cursor', cursor)).toBe(false)
    expect(JSON.parse(cursor)).toEqual({ access: jwt(later), vscdb: {} })
    expect(sync.hasRefresh('claude-code', claudeBlob(later))).toBe(true)
  })

  it('a transfer never carries the desktop app session', () => {
    core()
    const out = sync.forTransfer('claude-code', claudeBlob(later, 'R', { appSession: [{ name: 'sessionKey' }] }))
    expect(JSON.parse(out).appSession).toBeUndefined()
    expect(sync.hasRefresh('claude-code', out)).toBe(true)
    expect(sync.forTransfer('codex', codexBlob(later))).toBe(codexBlob(later))
  })

  it('ownership: no owner is this machine, a static profile is nobody\'s, another id is someone else', () => {
    core({ environmentId: 'env_me' })
    expect(sync.ownsProfile({})).toBe(true)
    expect(sync.ownsProfile({ owner: 'env_me' })).toBe(true)
    expect(sync.ownsProfile({ owner: 'env_box' })).toBe(false)
    expect(sync.ownsProfile({ static: true })).toBe(false)
    core()
    expect(sync.ownsProfile({ owner: 'env_box' })).toBe(false)
    expect(sync.ownsProfile({})).toBe(true)
  })
})

describe('exportAccount', () => {
  it('an owner sends an access copy naming itself, or a handoff naming the new owner', () => {
    core({ environmentId: 'env_mac' })
    vault.upsertProfile('claude-code', { name: 'a@x', accountId: 'u1', email: 'a@x', createdAt: 1 })
    vault.saveSecret('claude-code', 'a@x', claudeBlob(later, 'R', { appSession: [{ name: 'sessionKey' }] }))
    const access = sync.exportAccount('claude-code', 'a@x', 'access')
    expect(access).toMatchObject({ service: 'claude-code', mode: 'access', expiresAt: later, profile: { name: 'a@x', accountId: 'u1', static: false, owner: 'env_mac' } })
    expect(sync.hasRefresh('claude-code', access.blob)).toBe(false)
    expect(JSON.parse(access.blob).appSession).toBeUndefined()
    const handoff = sync.exportAccount('claude-code', 'a@x', 'handoff', 'env_box')
    expect(handoff).toMatchObject({ mode: 'handoff', profile: { owner: 'env_box' } })
    expect(sync.hasRefresh('claude-code', handoff.blob)).toBe(true)
    expect(JSON.parse(handoff.blob).appSession).toBeUndefined()
    expect(() => sync.exportAccount('claude-code', 'a@x', 'handoff')).toThrow(/names the new owner/)
  })

  it('a consumer never shares, a grant without a refresh token cannot be handed off, a static token goes as it is', () => {
    core({ environmentId: 'env_mac' })
    vault.upsertProfile('claude-code', { name: 'c', accountId: 'u2', createdAt: 1, owner: 'env_box' })
    vault.saveSecret('claude-code', 'c', claudeBlob(later, null))
    expect(() => sync.exportAccount('claude-code', 'c', 'access')).toThrow(/refreshed by env_box/)
    vault.upsertProfile('claude-code', { name: 'n', accountId: 'u3', createdAt: 1 })
    vault.saveSecret('claude-code', 'n', claudeBlob(later, null))
    expect(() => sync.exportAccount('claude-code', 'n', 'handoff', 'env_box')).toThrow(/no refresh token/)
    vault.upsertProfile('claude-code', { name: 's', accountId: 'u4', createdAt: 1, static: true })
    vault.saveSecret('claude-code', 's', JSON.stringify({ keychain: JSON.stringify({ claudeAiOauth: { accessToken: 'OAT', expiresAt: later } }), oauthAccount: {}, tokenKind: 'static' }))
    const out = sync.exportAccount('claude-code', 's', 'handoff', 'env_box')
    expect(out).toMatchObject({ mode: 'access', profile: { static: true, owner: null }, expiresAt: later })
    expect(sync.isStaticBlob(out.blob)).toBe(true)
  })
})

describe('applyTransfer', () => {
  const transfer = (mode: sync.TransferMode, owner: string | null, blob: string, profile: Partial<sync.TransferProfile> = {}): sync.Transfer => ({
    service: 'claude-code',
    mode,
    profile: { name: 'a@x', accountId: 'u1', email: 'a@x', createdAt: 5, static: false, owner, ...profile },
    blob,
    expiresAt: sync.accessExpiry('claude-code', blob)
  })

  it('a handoff addressed to this host lands the grant and makes it the owner; one for another host is refused', () => {
    core({ environmentId: 'env_box' })
    expect(sync.applyTransfer(transfer('handoff', 'env_other', claudeBlob(later)))).toEqual({ ok: false, reason: 'not-for-us' })
    expect(sync.applyTransfer(transfer('handoff', 'env_box', claudeBlob(later, null)))).toEqual({ ok: false, reason: 'bad-blob' })
    const out = sync.applyTransfer(transfer('handoff', 'env_box', claudeBlob(later)))
    expect(out).toEqual({ ok: true, name: 'a@x', saved: true, owner: 'env_box', expiresAt: later })
    const p = vault.profiles('claude-code')[0]
    expect(p).toMatchObject({ name: 'a@x', accountId: 'u1', email: 'a@x', createdAt: 5, owner: 'env_box', static: false })
    expect(p.syncedAt).toBeGreaterThan(0)
    expect(sync.hasRefresh('claude-code', vault.readSecret('claude-code', 'a@x')!)).toBe(true)
    expect(sync.ownsProfile(p)).toBe(true)
    // The same handoff again saves nothing new and still answers ok.
    expect(sync.applyTransfer(transfer('handoff', 'env_box', claudeBlob(later)))).toMatchObject({ ok: true, saved: true })
    expect(sync.applyTransfer(transfer('handoff', 'env_box', claudeBlob(earlier)))).toMatchObject({ ok: true, saved: false, expiresAt: later })
  })

  it('an access copy lands without a refresh token and names its owner; never where this host owns the grant', () => {
    core({ environmentId: 'env_mac' })
    const out = sync.applyTransfer(transfer('access', 'env_box', claudeBlob(later)))
    expect(out).toMatchObject({ ok: true, saved: true, owner: 'env_box', expiresAt: later })
    expect(sync.hasRefresh('claude-code', vault.readSecret('claude-code', 'a@x')!)).toBe(false)
    expect(vault.profiles('claude-code')[0]).toMatchObject({ owner: 'env_box', static: false })
    // Older never lands; same or newer does.
    expect(sync.applyTransfer(transfer('access', 'env_box', claudeBlob(earlier)))).toMatchObject({ ok: true, saved: false, expiresAt: later })
    expect(tokensOf(vault.readSecret('claude-code', 'a@x')!).accessToken).toBe(`T${later}`)
    expect(sync.applyTransfer(transfer('access', 'env_box', claudeBlob(later + 1)))).toMatchObject({ ok: true, saved: true, expiresAt: later + 1 })
    // A copy claiming this host as owner, or arriving for a grant this host owns, is a conflict.
    expect(sync.applyTransfer(transfer('access', 'env_mac', claudeBlob(later + 2)))).toEqual({ ok: false, reason: 'owner-mismatch' })
    vault.upsertProfile('claude-code', { name: 'mine', accountId: 'u9', createdAt: 1 })
    vault.saveSecret('claude-code', 'mine', claudeBlob(later))
    expect(sync.applyTransfer(transfer('access', 'env_box', claudeBlob(later + 3), { name: 'mine', accountId: 'u9', email: undefined }))).toEqual({ ok: false, reason: 'owner-mismatch' })
    expect(sync.applyTransfer(transfer('access', null, claudeBlob(later + 3)))).toEqual({ ok: false, reason: 'owner-mismatch' })
  })

  it('a static token replaces a consumer copy, keeps the row, and is never replaced by a push', () => {
    core({ environmentId: 'env_box' })
    vault.upsertProfile('claude-code', { name: 'kept-name', accountId: 'u1', email: 'a@x', createdAt: 3, color: 'c1', nickname: 'nick', owner: 'env_mac' })
    vault.saveSecret('claude-code', 'kept-name', claudeBlob(earlier, null))
    const year = Date.now() + 365 * 86_400_000
    const staticBlob = JSON.stringify({ keychain: JSON.stringify({ claudeAiOauth: { accessToken: 'OAT', expiresAt: year, scopes: ['user:inference'] } }), oauthAccount: { accountUuid: 'u1' }, tokenKind: 'static' })
    const out = sync.applyTransfer(transfer('access', null, staticBlob, { static: true }))
    expect(out).toEqual({ ok: true, name: 'kept-name', saved: true, owner: null, expiresAt: year })
    const p = vault.profiles('claude-code')[0]
    expect(p).toMatchObject({ name: 'kept-name', color: 'c1', nickname: 'nick', static: true })
    expect(p.owner).toBeUndefined()
    expect(sync.isStaticBlob(vault.readSecret('claude-code', 'kept-name')!)).toBe(true)
    expect(sync.applyTransfer(transfer('access', 'env_mac', claudeBlob(year + 1)))).toEqual({ ok: false, reason: 'static' })
    expect(sync.applyTransfer(transfer('handoff', 'env_box', claudeBlob(year + 1)))).toEqual({ ok: false, reason: 'static' })
  })

  it('refuses everything on a host with no environment id', () => {
    core()
    expect(sync.applyTransfer(transfer('access', 'env_mac', claudeBlob(later)))).toEqual({ ok: false, reason: 'no-environment' })
  })
})

describe('the sender after a handoff', () => {
  it('confirmHandoff strips the refresh token and records the owner, as a sync write; releaseTo does both and hands the grant out', () => {
    const saved: [string, SaveOrigin][] = []
    core({ environmentId: 'env_mac', hooks: { onSecretSaved: (_s, name, origin) => saved.push([name, origin]) } })
    vault.upsertProfile('claude-code', { name: 'a@x', accountId: 'u1', createdAt: 1 })
    vault.saveSecret('claude-code', 'a@x', claudeBlob(later, 'R', { appSession: [{ name: 'sessionKey' }] }))
    expect(saved).toEqual([['a@x', 'local']])
    sync.confirmHandoff('claude-code', 'a@x', 'env_box')
    expect(saved).toEqual([['a@x', 'local'], ['a@x', 'sync']])
    const stored = vault.readSecret('claude-code', 'a@x')!
    expect(sync.hasRefresh('claude-code', stored)).toBe(false)
    expect(JSON.parse(stored).appSession).toEqual([{ name: 'sessionKey' }])
    expect(vault.profiles('claude-code')[0]).toMatchObject({ owner: 'env_box', static: false })
    expect(sync.ownsProfile(vault.profiles('claude-code')[0])).toBe(false)

    vault.upsertProfile('codex', { name: 'c', accountId: 'acct', createdAt: 1 })
    vault.saveSecret('codex', 'c', codexBlob(later))
    const out = sync.releaseTo('codex', 'c', 'env_box')
    expect(out).toMatchObject({ service: 'codex', mode: 'handoff', profile: { owner: 'env_box' } })
    expect(sync.hasRefresh('codex', out.blob)).toBe(true)
    expect(sync.hasRefresh('codex', vault.readSecret('codex', 'c')!)).toBe(false)
    expect(vault.profiles('codex')[0].owner).toBe('env_box')
    sync.markSynced('codex', 'c')
    expect(vault.profiles('codex')[0].syncedAt).toBeGreaterThan(0)
  })
})

describe('saveStaticClaude', () => {
  it('makes a static row for a new account, and converts an existing row keeping its session and colour', () => {
    core({ environmentId: 'env_mac' })
    const year = Date.now() + 365 * 86_400_000
    const name = sync.saveStaticClaude({ token: 'sk-ant-oat01-x', expiresAt: year, accountId: 'u5', email: 'new@x' })
    expect(name).toBe('new@x')
    const blob = vault.readSecret('claude-code', 'new@x')!
    expect(sync.isStaticBlob(blob)).toBe(true)
    expect(tokensOf(blob)).toEqual({ accessToken: 'sk-ant-oat01-x', expiresAt: year, scopes: ['user:inference'] })
    expect(JSON.parse(blob).oauthAccount).toMatchObject({ accountUuid: 'u5', emailAddress: 'new@x' })
    expect(vault.profiles('claude-code').find((p) => p.name === 'new@x')).toMatchObject({ accountId: 'u5', email: 'new@x', static: true })

    vault.upsertProfile('claude-code', { name: 'old', accountId: 'u1', email: 'a@x', createdAt: 2, color: 'teal', owner: 'env_box', syncedAt: 9 })
    vault.saveSecret('claude-code', 'old', claudeBlob(later, 'R', { appSession: [{ name: 'sessionKey' }] }))
    expect(sync.saveStaticClaude({ token: 'OAT2', expiresAt: year, accountId: 'u1' })).toBe('old')
    const converted = vault.readSecret('claude-code', 'old')!
    expect(sync.isStaticBlob(converted)).toBe(true)
    expect(sync.hasRefresh('claude-code', converted)).toBe(false)
    expect(JSON.parse(converted)).toMatchObject({ oauthAccount: { accountUuid: 'u1', emailAddress: 'a@x' }, appSession: [{ name: 'sessionKey' }] })
    const p = vault.profiles('claude-code').find((x) => x.name === 'old')!
    expect(p).toMatchObject({ color: 'teal', static: true, email: 'a@x', createdAt: 2 })
    expect(p.owner).toBeUndefined()
    expect(p.syncedAt).toBeUndefined()
    expect(sync.ownsProfile(p)).toBe(false)
  })
})

describe('the vault save hook', () => {
  it('fires for every save with its origin', () => {
    const onSecretSaved = vi.fn()
    core({ hooks: { onSecretSaved } })
    vault.saveSecret('codex', 'c', codexBlob(later))
    vault.saveSecret('codex', 'c', codexBlob(later), 'sync')
    expect(onSecretSaved.mock.calls).toEqual([['codex', 'c', 'local'], ['codex', 'c', 'sync']])
  })
})
