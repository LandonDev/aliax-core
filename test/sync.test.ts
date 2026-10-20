import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SaveOrigin } from '../src/config'
import { isLocked } from '../src/lock'
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

  it('a handoff addressed to this host lands the grant provisionally, with the fingerprint of what it saved; one for another host is refused', () => {
    core({ environmentId: 'env_box' })
    expect(sync.applyTransfer(transfer('handoff', 'env_other', claudeBlob(later)), 'env_mac')).toEqual({ ok: false, reason: 'not-for-us' })
    expect(sync.applyTransfer(transfer('handoff', 'env_box', claudeBlob(later, null)), 'env_mac')).toEqual({ ok: false, reason: 'bad-blob' })
    const sent = claudeBlob(later)
    const out = sync.applyTransfer(transfer('handoff', 'env_box', sent), 'env_mac')
    expect(out).toEqual({ ok: true, name: 'a@x', saved: true, owner: 'env_mac', expiresAt: later, refreshFingerprint: sync.refreshFingerprint('claude-code', sent) })
    const p = vault.profiles('claude-code')[0]
    // The row still names the sender: nothing here refreshes the grant until the sender says it stripped its own copy.
    expect(p).toMatchObject({ name: 'a@x', accountId: 'u1', email: 'a@x', createdAt: 5, owner: 'env_mac', static: false })
    expect(p.syncedAt).toBeGreaterThan(0)
    expect(sync.hasRefresh('claude-code', vault.readSecret('claude-code', 'a@x')!)).toBe(true)
    expect(sync.ownsProfile(p)).toBe(false)
    expect(sync.isProvisional('claude-code', p)).toBe(true)
    // The same handoff again saves again and answers the same fingerprint.
    expect(sync.applyTransfer(transfer('handoff', 'env_box', sent), 'env_mac')).toMatchObject({ ok: true, saved: true, refreshFingerprint: sync.refreshFingerprint('claude-code', sent) })
    // The sender's word makes this host the owner; twice is fine; a stranger's word is not.
    expect(sync.claimHandoff('claude-code', 'a@x', 'env_other')).toBe(false)
    expect(sync.claimHandoff('claude-code', 'a@x', 'env_mac')).toBe(true)
    expect(sync.claimHandoff('claude-code', 'a@x', 'env_mac')).toBe(true)
    expect(vault.profiles('claude-code')[0]).toMatchObject({ owner: 'env_box' })
    expect(sync.ownsProfile(vault.profiles('claude-code')[0])).toBe(true)
    expect(sync.isProvisional('claude-code', vault.profiles('claude-code')[0])).toBe(false)
    // An older handoff onto a host that holds a refresh token changes nothing and names the token it holds.
    expect(sync.applyTransfer(transfer('handoff', 'env_box', claudeBlob(earlier)), 'env_mac')).toEqual({ ok: true, name: 'a@x', saved: false, owner: 'env_box', expiresAt: later, refreshFingerprint: sync.refreshFingerprint('claude-code', sent) })
    expect(sync.hasRefresh('claude-code', vault.readSecret('claude-code', 'a@x')!)).toBe(true)
  })

  it('an older handoff onto an access-only copy is refused as stale, so the sender keeps its only refresh token', () => {
    core({ environmentId: 'env_box' })
    vault.upsertProfile('claude-code', { name: 'a@x', accountId: 'u1', createdAt: 1, owner: 'env_mac' })
    vault.saveSecret('claude-code', 'a@x', claudeBlob(later, null))
    expect(sync.applyTransfer(transfer('handoff', 'env_box', claudeBlob(earlier)), 'env_mac')).toEqual({ ok: false, reason: 'stale' })
    expect(vault.profiles('claude-code')[0]).toMatchObject({ owner: 'env_mac' })
    expect(sync.hasRefresh('claude-code', vault.readSecret('claude-code', 'a@x')!)).toBe(false)
    expect(sync.claimHandoff('claude-code', 'a@x', 'env_mac')).toBe(false)
    // A fresher one lands.
    expect(sync.applyTransfer(transfer('handoff', 'env_box', claudeBlob(later + 1)), 'env_mac')).toMatchObject({ ok: true, saved: true, refreshFingerprint: expect.any(String) })
  })

  it('under the peer policy only an account already on file may arrive, and an access copy must name its sender', () => {
    core({ environmentId: 'env_mac' })
    expect(sync.applyTransfer(transfer('access', 'env_box', claudeBlob(later)), 'env_box', 'peer')).toEqual({ ok: false, reason: 'unknown-account' })
    expect(sync.applyTransfer(transfer('access', null, claudeBlob(later), { static: true }), 'env_box', 'peer')).toEqual({ ok: false, reason: 'unknown-account' })
    expect(vault.profiles('claude-code')).toEqual([])
    vault.upsertProfile('claude-code', { name: 'a@x', accountId: 'u1', email: 'a@x', createdAt: 1, owner: 'env_box' })
    vault.saveSecret('claude-code', 'a@x', claudeBlob(earlier, null))
    // A copy the sender claims a third host owns is not the sender's to push.
    expect(sync.applyTransfer(transfer('access', 'env_third', claudeBlob(later)), 'env_box', 'peer')).toEqual({ ok: false, reason: 'not-owner' })
    expect(sync.applyTransfer(transfer('access', 'env_box', claudeBlob(later)), 'env_box', 'peer')).toMatchObject({ ok: true, saved: true, owner: 'env_box' })
    // The same account by email alone still counts as on file; a static token for a row that is not static does not.
    expect(sync.applyTransfer(transfer('access', 'env_box', claudeBlob(later + 1), { accountId: 'u1-renamed' }), 'env_box', 'peer')).toMatchObject({ ok: true, saved: true })
    expect(sync.applyTransfer(transfer('access', null, claudeBlob(later + 2), { static: true }), 'env_box', 'peer')).toEqual({ ok: false, reason: 'unknown-account' })
    // An admin sender may bring a new account.
    expect(sync.applyTransfer(transfer('access', 'env_box', claudeBlob(later), { name: 'n', accountId: 'u2', email: 'n@x' }), 'env_box')).toMatchObject({ ok: true, saved: true })
  })

  it('an access copy never voids a grant someone else is handing over; the owner it names may, by its own copy', () => {
    core({ environmentId: 'env_box' })
    const sent = claudeBlob(later)
    expect(sync.applyTransfer(transfer('handoff', 'env_box', sent), 'env_mac')).toMatchObject({ ok: true, saved: true })
    // A third host's access copy: the grant from env_mac is still being settled.
    expect(sync.applyTransfer(transfer('access', 'env_third', claudeBlob(later + 1)), 'env_third')).toEqual({ ok: false, reason: 'provisional' })
    expect(sync.hasRefresh('claude-code', vault.readSecret('claude-code', 'a@x')!)).toBe(true)
    // env_mac's own access copy means it kept the grant: the provisional copy gives way.
    expect(sync.applyTransfer(transfer('access', 'env_mac', claudeBlob(later + 1)), 'env_mac')).toMatchObject({ ok: true, saved: true, owner: 'env_mac' })
    expect(sync.hasRefresh('claude-code', vault.readSecret('claude-code', 'a@x')!)).toBe(false)
    expect(sync.claimHandoff('claude-code', 'a@x', 'env_mac')).toBe(false)
  })

  it('an access copy lands without a refresh token and names its owner; never where this host owns the grant', () => {
    core({ environmentId: 'env_mac' })
    const out = sync.applyTransfer(transfer('access', 'env_box', claudeBlob(later)), 'env_box')
    expect(out).toMatchObject({ ok: true, saved: true, owner: 'env_box', expiresAt: later, refreshFingerprint: null })
    expect(sync.hasRefresh('claude-code', vault.readSecret('claude-code', 'a@x')!)).toBe(false)
    expect(vault.profiles('claude-code')[0]).toMatchObject({ owner: 'env_box', static: false })
    // Older never lands; same or newer does.
    expect(sync.applyTransfer(transfer('access', 'env_box', claudeBlob(earlier)), 'env_box')).toMatchObject({ ok: true, saved: false, expiresAt: later })
    expect(tokensOf(vault.readSecret('claude-code', 'a@x')!).accessToken).toBe(`T${later}`)
    expect(sync.applyTransfer(transfer('access', 'env_box', claudeBlob(later + 1)), 'env_box')).toMatchObject({ ok: true, saved: true, expiresAt: later + 1 })
    // A copy claiming this host as owner, or arriving for a grant this host owns, is a conflict.
    expect(sync.applyTransfer(transfer('access', 'env_mac', claudeBlob(later + 2)), 'env_mac')).toEqual({ ok: false, reason: 'owner-mismatch' })
    vault.upsertProfile('claude-code', { name: 'mine', accountId: 'u9', createdAt: 1 })
    vault.saveSecret('claude-code', 'mine', claudeBlob(later))
    expect(sync.applyTransfer(transfer('access', 'env_box', claudeBlob(later + 3), { name: 'mine', accountId: 'u9', email: undefined }), 'env_box')).toEqual({ ok: false, reason: 'owner-mismatch' })
    expect(sync.applyTransfer(transfer('access', null, claudeBlob(later + 3)), 'env_box')).toEqual({ ok: false, reason: 'owner-mismatch' })
  })

  it('a static token replaces a consumer copy, keeps the row, and is never replaced by a push', () => {
    core({ environmentId: 'env_box' })
    vault.upsertProfile('claude-code', { name: 'kept-name', accountId: 'u1', email: 'a@x', createdAt: 3, color: 'c1', nickname: 'nick', owner: 'env_mac' })
    vault.saveSecret('claude-code', 'kept-name', claudeBlob(earlier, null))
    const year = Date.now() + 365 * 86_400_000
    const staticBlob = JSON.stringify({ keychain: JSON.stringify({ claudeAiOauth: { accessToken: 'OAT', expiresAt: year, scopes: ['user:inference'] } }), oauthAccount: { accountUuid: 'u1' }, tokenKind: 'static' })
    const out = sync.applyTransfer(transfer('access', null, staticBlob, { static: true }), 'env_mac')
    expect(out).toEqual({ ok: true, name: 'kept-name', saved: true, owner: null, expiresAt: year, refreshFingerprint: null })
    const p = vault.profiles('claude-code')[0]
    expect(p).toMatchObject({ name: 'kept-name', color: 'c1', nickname: 'nick', static: true })
    expect(p.owner).toBeUndefined()
    expect(sync.isStaticBlob(vault.readSecret('claude-code', 'kept-name')!)).toBe(true)
    expect(sync.applyTransfer(transfer('access', 'env_mac', claudeBlob(year + 1)), 'env_mac')).toEqual({ ok: false, reason: 'static' })
    expect(sync.applyTransfer(transfer('handoff', 'env_box', claudeBlob(year + 1)), 'env_mac')).toEqual({ ok: false, reason: 'static' })
  })

  it('refuses everything on a host with no environment id', () => {
    core()
    expect(sync.applyTransfer(transfer('access', 'env_mac', claudeBlob(later)), 'env_mac')).toEqual({ ok: false, reason: 'no-environment' })
  })
})

describe('the sender after a handoff', () => {
  it('confirmHandoff strips the refresh token, records the owner and the release, as a sync write; clearReleased forgets the release', () => {
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
    expect(vault.profiles('claude-code')[0].releasedAt).toBeGreaterThan(0)
    expect(sync.ownsProfile(vault.profiles('claude-code')[0])).toBe(false)
    sync.clearReleased('claude-code', 'a@x')
    expect(vault.profiles('claude-code')[0].releasedAt).toBeUndefined()
    sync.markSynced('claude-code', 'a@x')
    expect(vault.profiles('claude-code')[0].syncedAt).toBeGreaterThan(0)
  })

  it('beginHandoff holds the lock from the export to commit or abort; commit strips, abort keeps the grant', async () => {
    core({ environmentId: 'env_mac' })
    vault.upsertProfile('codex', { name: 'c', accountId: 'acct', createdAt: 1 })
    vault.saveSecret('codex', 'c', codexBlob(later))
    const h = await sync.beginHandoff('codex', 'c', 'env_box')
    expect(h.transfer).toMatchObject({ service: 'codex', mode: 'handoff', profile: { owner: 'env_box' } })
    expect(sync.hasRefresh('codex', h.transfer.blob)).toBe(true)
    expect(h.fingerprint).toBe(sync.refreshFingerprint('codex', h.transfer.blob))
    expect(isLocked('codex', 'c')).toBe(true)
    // A second handoff of the same grant waits for the first to settle.
    let second: sync.Handoff | null = null
    const waiting = sync.beginHandoff('codex', 'c', 'env_other').then((x) => (second = x))
    await new Promise((r) => setTimeout(r, 10))
    expect(second).toBeNull()
    h.abort()
    expect(sync.hasRefresh('codex', vault.readSecret('codex', 'c')!)).toBe(true)
    expect(vault.profiles('codex')[0].owner).toBeUndefined()
    await waiting
    expect(second).not.toBeNull()
    second!.commit()
    second!.commit()
    expect(isLocked('codex', 'c')).toBe(false)
    expect(sync.hasRefresh('codex', vault.readSecret('codex', 'c')!)).toBe(false)
    expect(vault.profiles('codex')[0]).toMatchObject({ owner: 'env_other' })
    expect(vault.profiles('codex')[0].releasedAt).toBeGreaterThan(0)
    // Nothing left to hand off: the export fails and the lock is not kept.
    await expect(sync.beginHandoff('codex', 'c', 'env_box')).rejects.toThrow(/refreshed by env_other/)
    expect(isLocked('codex', 'c')).toBe(false)
  })

  it('refreshFingerprint digests the refresh token of every service and never the token itself', () => {
    core()
    const claude = sync.refreshFingerprint('claude-code', claudeBlob(later, 'secret-R'))!
    expect(claude).toMatch(/^[0-9a-f]{16}$/)
    expect(claude).not.toContain('secret')
    expect(sync.refreshFingerprint('claude-code', claudeBlob(later, 'secret-R'))).toBe(claude)
    expect(sync.refreshFingerprint('claude-code', claudeBlob(later, 'other'))).not.toBe(claude)
    expect(sync.refreshFingerprint('claude-code', claudeBlob(later, null))).toBeNull()
    expect(sync.refreshFingerprint('codex', codexBlob(later))).toMatch(/^[0-9a-f]{16}$/)
    expect(sync.refreshFingerprint('cursor', cursorBlob(later))).toMatch(/^[0-9a-f]{16}$/)
    expect(sync.refreshFingerprint('codex', 'garbage')).toBeNull()
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
