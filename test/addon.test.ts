import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { adapterForTest, listServices, saveAddonGrant } from '../src/accounts'
import { addon, addonGrantOf, ADDON_SERVICE, type AddonGrant } from '../src/adapters/addon'
import { configure } from '../src/config'
import { refreshAddon } from '../src/refresh'
import * as sync from '../src/sync'
import * as vault from '../src/vault'
import { randomChromiumKey, useFixedChromiumKey } from '../src/vault'
import { jsonResponse, noFetch, tempCore } from './helpers'

const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
  vi.useRealTimers()
})
const core = (overrides: Parameters<typeof tempCore>[0] = {}): string => {
  const { dataDir, cleanup } = tempCore(overrides)
  cleanups.push(cleanup)
  return dataDir
}

const HOUR = 3_600_000
const TOKEN_URL = 'https://auth.example.com/as/token'

/** The schema's full blob (temp-code src/shared/addonGrant.ts AddonGrantBlobSchema), as JSON. */
const FIXTURE = `{"v":1,"mintedBy":"app","addonId":"ad_mobbin00001","fields":{"X-Team":"design"},"oauth":{"clientId":"cl_1","clientSecret":"cs_1","redirectPort":53682,"authorizationUrl":"https://auth.example.com/as/authorize","tokenUrl":"${TOKEN_URL}","scope":"mcp offline_access","resource":"https://api.example.com/mcp","issuer":"https://auth.example.com/as","accessToken":"AT1","refreshToken":"RT1","expiresAt":1900000000000}}`

const grant = (oauth: Partial<NonNullable<AddonGrant['oauth']>> | null = {}, fields: Record<string, string> = {}, addonId = 'ad_a'): string =>
  JSON.stringify({
    v: 1,
    mintedBy: 'app',
    addonId,
    fields,
    ...(oauth
      ? { oauth: { clientId: 'cl', redirectPort: 50000, authorizationUrl: 'https://auth.example.com/as/authorize', tokenUrl: TOKEN_URL, accessToken: 'AT', refreshToken: 'RT', expiresAt: Date.now() + HOUR, ...oauth } }
      : {})
  })
const oauthOf = (blob: string | null): Record<string, unknown> => JSON.parse(blob!).oauth

describe('the addon adapter', () => {
  it('parses the schema fixture and refuses anything else', () => {
    const g = addonGrantOf(FIXTURE)!
    expect(g).toMatchObject({ addonId: 'ad_mobbin00001', fields: { 'X-Team': 'design' }, oauth: { clientId: 'cl_1', redirectPort: 53682, refreshToken: 'RT1' } })
    expect(addonGrantOf('nope')).toBeNull()
    expect(addonGrantOf('{"v":2,"mintedBy":"app","addonId":"a","fields":{}}')).toBeNull()
    expect(addonGrantOf('{"v":1,"mintedBy":"cli","addonId":"a","fields":{}}')).toBeNull()
    expect(addonGrantOf('{"v":1,"mintedBy":"app","addonId":"a","fields":{"x":1}}')).toBeNull()
    expect(addonGrantOf('{"v":1,"mintedBy":"app","addonId":"a","fields":{},"oauth":{"clientId":"c"}}')).toBeNull()
  })

  it('is internal, has no live credential, no capture, no switch, and is identified by the add-on id', async () => {
    core()
    expect(addon.internal).toBe(true)
    expect(addon.detect()).toBe(true)
    expect(addon.supportsLogin).toBe(false)
    expect(await addon.liveAccountId()).toBeNull()
    expect(await addon.liveFingerprint!()).toBeNull()
    await expect(addon.capture(() => '')).rejects.toThrow(/saved by the app/)
    expect(await addon.activate(FIXTURE, () => '', new Set())).toEqual([])
    expect(await addon.identify!(FIXTURE)).toEqual({ accountId: 'ad_mobbin00001' })
    expect(await addon.identify!('{}')).toBeNull()
    expect(adapterForTest(ADDON_SERVICE)).toBe(addon)
  })

  it('reports its state as a settled note, expired only when the token lapsed with no refresh token here', async () => {
    expect(await addon.usage(grant(null, { K: 'v' }), false)).toEqual({ windows: [], settled: true, note: 'values saved' })
    expect(await addon.usage(grant({ accessToken: undefined, refreshToken: undefined, expiresAt: undefined }), false)).toMatchObject({ note: 'not signed in' })
    expect(await addon.usage(grant(), false)).toEqual({ windows: [], settled: true, note: 'signed in' })
    expect(await addon.usage(grant({ expiresAt: Date.now() - 1 }), false)).not.toHaveProperty('expired')
    expect(await addon.usage(grant({ expiresAt: Date.now() - 1, refreshToken: undefined }), false)).toMatchObject({ note: 'signed in', expired: true })
  })

  it('fingerprints the refresh token with the app prefix, else the add-on id', () => {
    const digest = createHash('sha256').update('RT').digest('hex')
    expect(addon.fingerprintOf!(grant())).toBe(`app:${digest}`)
    expect(addon.fingerprintOf!(grant({ refreshToken: undefined }))).toBe('app:ad_a')
    expect(addon.fingerprintOf!(grant(null))).toBe('app:ad_a')
    expect(addon.fingerprintOf!('garbage')).toBeNull()
  })

  it('no account page lists it', async () => {
    core()
    saveAddonGrant({ addonId: 'ad_a', nickname: 'a', blob: grant(null, { K: 'v' }) })
    expect((await listServices()).map((s) => s.id)).not.toContain(ADDON_SERVICE)
  })
})

describe('sync.ts for add-on grants', () => {
  it('reads the expiry and the refresh token from the oauth section, strips only the refresh token', () => {
    core()
    expect(sync.accessExpiry(ADDON_SERVICE, FIXTURE)).toBe(1900000000000)
    expect(sync.accessExpiry(ADDON_SERVICE, grant(null))).toBeNull()
    expect(sync.hasRefresh(ADDON_SERVICE, FIXTURE)).toBe(true)
    expect(sync.hasRefresh(ADDON_SERVICE, grant(null))).toBe(false)
    const stripped = sync.stripRefresh(ADDON_SERVICE, FIXTURE)
    expect(sync.hasRefresh(ADDON_SERVICE, stripped)).toBe(false)
    const { refreshToken: _, ...rest } = JSON.parse(FIXTURE).oauth
    expect(JSON.parse(stripped)).toEqual({ ...JSON.parse(FIXTURE), oauth: rest })
    expect(sync.stripRefresh(ADDON_SERVICE, grant(null, { K: 'v' }))).toBe(grant(null, { K: 'v' }))
    expect(sync.refreshFingerprint(ADDON_SERVICE, FIXTURE)).toBe(createHash('sha256').update('RT1').digest('hex').slice(0, 16))
    expect(sync.refreshFingerprint(ADDON_SERVICE, grant(null))).toBeNull()
  })

  const transfer = (mode: sync.TransferMode, owner: string | null, blob: string, isStatic = false): sync.Transfer => ({
    service: ADDON_SERVICE,
    mode,
    profile: { name: 'ad_a', accountId: 'ad_a', nickname: 'a', createdAt: 5, static: isStatic, owner },
    blob,
    expiresAt: sync.accessExpiry(ADDON_SERVICE, blob)
  })

  it('a sign-in replaces a static row of typed values: a handoff and an access copy land over it', () => {
    core({ environmentId: 'env_box' })
    vault.upsertProfile(ADDON_SERVICE, { name: 'ad_a', accountId: 'ad_a', createdAt: 1, static: true })
    vault.saveSecret(ADDON_SERVICE, 'ad_a', grant(null, { K: 'v' }))
    const sent = grant({}, { K: 'v' })
    expect(sync.applyTransfer(transfer('handoff', 'env_box', sent), 'env_mac')).toMatchObject({ ok: true, saved: true, owner: 'env_mac' })
    expect(vault.profiles(ADDON_SERVICE)[0]).toMatchObject({ static: false, owner: 'env_mac' })
    expect(sync.claimHandoff(ADDON_SERVICE, 'ad_a', 'env_mac')).toBe(true)
    // A Claude row stays refused as before.
    vault.upsertProfile('claude-code', { name: 'c', accountId: 'u', createdAt: 1, static: true })
    vault.saveSecret('claude-code', 'c', JSON.stringify({ keychain: '{}', tokenKind: 'static' }))
    expect(
      sync.applyTransfer({ service: 'claude-code', mode: 'access', profile: { name: 'c', accountId: 'u', createdAt: 1, static: false, owner: 'env_mac' }, blob: '{}', expiresAt: null }, 'env_mac')
    ).toEqual({ ok: false, reason: 'static' })

    core({ environmentId: 'env_box' })
    vault.upsertProfile(ADDON_SERVICE, { name: 'ad_a', accountId: 'ad_a', createdAt: 1, static: true })
    vault.saveSecret(ADDON_SERVICE, 'ad_a', grant(null, { K: 'v' }))
    expect(sync.applyTransfer(transfer('access', 'env_mac', sync.stripRefresh(ADDON_SERVICE, sent)), 'env_mac')).toMatchObject({ ok: true, saved: true, owner: 'env_mac' })
    expect(vault.profiles(ADDON_SERVICE)[0]).toMatchObject({ static: false, owner: 'env_mac' })
  })

  it('a static copy never lands over a grant with a sign-in: owned here, an access copy, or provisional; the row is left as it was', () => {
    const fieldsOnly = transfer('access', null, grant(null, { K: 'old' }), true)
    // Owned here.
    core({ environmentId: 'env_box' })
    vault.upsertProfile(ADDON_SERVICE, { name: 'ad_a', accountId: 'ad_a', createdAt: 1 })
    vault.saveSecret(ADDON_SERVICE, 'ad_a', grant())
    const before = vault.profiles(ADDON_SERVICE)[0]
    expect(sync.applyTransfer(fieldsOnly, 'env_mac')).toEqual({ ok: false, reason: 'owner-mismatch' })
    expect(vault.profiles(ADDON_SERVICE)[0]).toEqual(before)
    expect(sync.hasRefresh(ADDON_SERVICE, vault.readSecret(ADDON_SERVICE, 'ad_a')!)).toBe(true)
    // An access copy of another host's grant.
    core({ environmentId: 'env_mac' })
    vault.upsertProfile(ADDON_SERVICE, { name: 'ad_a', accountId: 'ad_a', createdAt: 1, owner: 'env_box', syncedAt: 7 })
    vault.saveSecret(ADDON_SERVICE, 'ad_a', grant({ refreshToken: undefined }))
    const copy = vault.profiles(ADDON_SERVICE)[0]
    expect(sync.applyTransfer(fieldsOnly, 'env_box')).toEqual({ ok: false, reason: 'owner-mismatch' })
    expect(vault.profiles(ADDON_SERVICE)[0]).toEqual(copy)
    // A provisional copy of a handoff in flight.
    core({ environmentId: 'env_box' })
    expect(sync.applyTransfer(transfer('handoff', 'env_box', grant()), 'env_mac')).toMatchObject({ ok: true })
    const provisional = vault.profiles(ADDON_SERVICE)[0]
    expect(sync.isProvisional(ADDON_SERVICE, provisional)).toBe(true)
    expect(sync.applyTransfer(fieldsOnly, 'env_mac')).toEqual({ ok: false, reason: 'owner-mismatch' })
    expect(vault.profiles(ADDON_SERVICE)[0]).toEqual(provisional)
    // A static row takes a newer static copy as before.
    core({ environmentId: 'env_mac' })
    vault.upsertProfile(ADDON_SERVICE, { name: 'ad_a', accountId: 'ad_a', createdAt: 1, static: true })
    vault.saveSecret(ADDON_SERVICE, 'ad_a', grant(null, { K: 'old' }))
    expect(sync.applyTransfer(transfer('access', null, grant(null, { K: 'new' }), true), 'env_box', 'peer')).toMatchObject({ ok: true, saved: true })
    expect(JSON.parse(vault.readSecret(ADDON_SERVICE, 'ad_a')!).fields).toEqual({ K: 'new' })
  })

  it('a handoff goes beginHandoff → applyTransfer → claimHandoff → commit, leaving the sender access-only with its client and port', async () => {
    const key = randomChromiumKey()
    const dirs = { mac: mkdtempSync(join(tmpdir(), 'aliax-core-mac-')), box: mkdtempSync(join(tmpdir(), 'aliax-core-box-')) }
    cleanups.push(() => Object.values(dirs).forEach((d) => rmSync(d, { recursive: true, force: true })))
    const use = (host: 'mac' | 'box'): void => {
      configure({ dataDir: dirs[host], fetch: noFetch, secrets: { mode: 'chromiumKey', keychainItem: 'Test Safe Storage' }, environmentId: `env_${host}` })
      useFixedChromiumKey('Test Safe Storage', key)
    }
    use('mac')
    saveAddonGrant({ addonId: 'ad_a', nickname: 'a', blob: grant({ redirectPort: 51234, clientId: 'cl_9' }, { K: 'v' }), signedIn: true })
    const handoff = await sync.beginHandoff(ADDON_SERVICE, 'ad_a', 'env_box')
    expect(handoff.transfer).toMatchObject({ mode: 'handoff', profile: { owner: 'env_box', static: false } })
    use('box')
    const out = sync.applyTransfer(handoff.transfer, 'env_mac')
    expect(out).toMatchObject({ ok: true, saved: true, refreshFingerprint: handoff.fingerprint })
    expect(sync.claimHandoff(ADDON_SERVICE, 'ad_a', 'env_mac')).toBe(true)
    expect(sync.ownsProfile(vault.profiles(ADDON_SERVICE)[0])).toBe(true)
    use('mac')
    handoff.commit()
    const left = vault.readSecret(ADDON_SERVICE, 'ad_a')!
    expect(sync.hasRefresh(ADDON_SERVICE, left)).toBe(false)
    expect(oauthOf(left)).toMatchObject({ clientId: 'cl_9', redirectPort: 51234, accessToken: 'AT' })
    expect(JSON.parse(left).fields).toEqual({ K: 'v' })
    expect(vault.profiles(ADDON_SERVICE)[0]).toMatchObject({ owner: 'env_box', static: false })
  })
})

describe('refreshAddon', () => {
  const ownedHere = (blob = grant()): void => {
    vault.upsertProfile(ADDON_SERVICE, { name: 'ad_a', accountId: 'ad_a', createdAt: 1 })
    vault.saveSecret(ADDON_SERVICE, 'ad_a', blob)
  }
  const tokenServer = (answer: (body: URLSearchParams) => Response | Promise<Response>) =>
    vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe(TOKEN_URL)
      expect((init!.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded')
      return answer(new URLSearchParams(String(init!.body)))
    })

  it('rotates: posts the stored refresh token, saves the new pair onto the stored blob', async () => {
    const fetch = tokenServer((body) => {
      expect(Object.fromEntries(body)).toEqual({ grant_type: 'refresh_token', refresh_token: 'RT', client_id: 'cl', client_secret: 'cs', resource: 'https://api.example.com/mcp' })
      return jsonResponse({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 600, scope: 'mcp offline_access' })
    })
    core({ fetch, environmentId: 'env_box' })
    ownedHere(grant({ clientSecret: 'cs', resource: 'https://api.example.com/mcp', expiresAt: Date.now() + 10_000 }, { K: 'v' }))
    const out = await refreshAddon('ad_a')
    expect(out.ok).toBe(true)
    const stored = vault.readSecret(ADDON_SERVICE, 'ad_a')
    expect(oauthOf(stored)).toMatchObject({ accessToken: 'AT2', refreshToken: 'RT2', scope: 'mcp offline_access', clientSecret: 'cs' })
    expect(oauthOf(stored).expiresAt).toBeGreaterThan(Date.now() + 590_000)
    expect(JSON.parse(stored!).fields).toEqual({ K: 'v' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('keeps the old refresh token when none comes back, and sends no secret or resource it does not hold', async () => {
    const fetch = tokenServer((body) => {
      expect(body.has('client_secret')).toBe(false)
      expect(body.has('resource')).toBe(false)
      return jsonResponse({ access_token: 'AT2' })
    })
    core({ fetch, environmentId: 'env_box' })
    ownedHere(grant({ expiresAt: Date.now() - 1 }))
    expect((await refreshAddon('ad_a')).ok).toBe(true)
    const o = oauthOf(vault.readSecret(ADDON_SERVICE, 'ad_a'))
    expect(o).toMatchObject({ accessToken: 'AT2', refreshToken: 'RT' })
    expect(o).not.toHaveProperty('expiresAt')
  })

  it('answers refused on 400/401 and network on anything else, saving nothing', async () => {
    let status = 400
    const fetch = tokenServer(() => jsonResponse({ error: 'invalid_grant' }, { status }))
    core({ fetch, environmentId: 'env_box' })
    ownedHere(grant({ expiresAt: Date.now() - 1 }))
    expect(await refreshAddon('ad_a')).toEqual({ ok: false, reason: 'refused' })
    status = 401
    expect(await refreshAddon('ad_a')).toEqual({ ok: false, reason: 'refused' })
    status = 503
    expect(await refreshAddon('ad_a')).toEqual({ ok: false, reason: 'network' })
    expect(oauthOf(vault.readSecret(ADDON_SERVICE, 'ad_a')).accessToken).toBe('AT')
    const failing = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    core({ fetch: failing, environmentId: 'env_box' })
    ownedHere(grant({ expiresAt: Date.now() - 1 }))
    expect(await refreshAddon('ad_a')).toEqual({ ok: false, reason: 'network' })
  })

  it('a copy asks its owner and never the token endpoint; force always asks', async () => {
    const askOwner = vi.fn(async () => grant({ accessToken: 'FROM_OWNER', refreshToken: undefined }))
    core({ fetch: noFetch, environmentId: 'env_mac', hooks: { askOwner } })
    vault.upsertProfile(ADDON_SERVICE, { name: 'ad_a', accountId: 'ad_a', createdAt: 1, owner: 'env_box' })
    vault.saveSecret(ADDON_SERVICE, 'ad_a', grant({ refreshToken: undefined, expiresAt: Date.now() + 10_000 }))
    expect(await refreshAddon('ad_a')).toMatchObject({ ok: true })
    expect(askOwner).toHaveBeenCalledWith(ADDON_SERVICE, 'ad_a', 'env_box')
    // A long-lived copy: no ask without force, an ask with it.
    vault.saveSecret(ADDON_SERVICE, 'ad_a', grant({ refreshToken: undefined, expiresAt: Date.now() + HOUR }))
    askOwner.mockClear()
    expect(await refreshAddon('ad_a')).toMatchObject({ ok: true })
    expect(askOwner).not.toHaveBeenCalled()
    expect(await refreshAddon('ad_a', { force: true })).toMatchObject({ ok: true })
    expect(askOwner).toHaveBeenCalledTimes(1)
    askOwner.mockResolvedValueOnce(null as never)
    expect(await refreshAddon('ad_a', { force: true })).toEqual({ ok: false, reason: 'owner-unreachable' })
  })

  it('two concurrent calls make one POST; a token with time left and no force makes none', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const fetch = tokenServer(async () => {
      await gate
      return jsonResponse({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 600 })
    })
    core({ fetch, environmentId: 'env_box' })
    ownedHere(grant({ expiresAt: Date.now() - 1 }))
    const a = refreshAddon('ad_a')
    const b = refreshAddon('ad_a', { force: true })
    release()
    expect(await a).toEqual(await b)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(await refreshAddon('ad_a')).toMatchObject({ ok: true })
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(await refreshAddon('ad_a', { minValidMs: 700_000 })).toMatchObject({ ok: true })
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('a static grant, an unknown grant and an owned grant with no refresh token renew nothing', async () => {
    core({ fetch: noFetch, environmentId: 'env_box' })
    expect(await refreshAddon('ad_none')).toEqual({ ok: false, reason: 'no-grant' })
    saveAddonGrant({ addonId: 'ad_a', nickname: 'a', blob: grant(null, { K: 'v' }) })
    expect(await refreshAddon('ad_a')).toEqual({ ok: false, reason: 'static' })
    saveAddonGrant({ addonId: 'ad_b', nickname: 'b', blob: grant({ refreshToken: undefined, expiresAt: Date.now() - 1 }, {}, 'ad_b'), signedIn: true })
    expect(await refreshAddon('ad_b')).toEqual({ ok: false, reason: 'no-refresh' })
  })

  it('saves nothing when the profile went during the POST, and keeps values saved during it', async () => {
    let during: () => void = () => {}
    const fetch = tokenServer(async () => {
      during()
      return jsonResponse({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 600 })
    })
    core({ fetch, environmentId: 'env_box' })
    ownedHere(grant({ expiresAt: Date.now() - 1 }))
    during = () => vault.deleteProfile(ADDON_SERVICE, 'ad_a')
    expect(await refreshAddon('ad_a')).toEqual({ ok: false, reason: 'no-grant' })
    expect(vault.readSecret(ADDON_SERVICE, 'ad_a')).toBeNull()
    expect(vault.profiles(ADDON_SERVICE)).toEqual([])

    ownedHere(grant({ expiresAt: Date.now() - 1 }, { K: 'old' }))
    during = () => vault.saveSecret(ADDON_SERVICE, 'ad_a', grant({ expiresAt: Date.now() - 1 }, { K: 'new' }))
    expect(await refreshAddon('ad_a')).toMatchObject({ ok: true })
    const stored = JSON.parse(vault.readSecret(ADDON_SERVICE, 'ad_a')!)
    expect(stored.fields).toEqual({ K: 'new' })
    expect(stored.oauth.accessToken).toBe('AT2')
  })

  it('never saves backwards: a later stored expiry wins', async () => {
    const far = Date.now() + 10 * HOUR
    const fetch = tokenServer(async () => {
      vault.saveSecret(ADDON_SERVICE, 'ad_a', grant({ accessToken: 'NEWER', expiresAt: far }))
      return jsonResponse({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 60 })
    })
    core({ fetch, environmentId: 'env_box' })
    ownedHere(grant({ expiresAt: Date.now() - 1 }))
    expect(await refreshAddon('ad_a', { force: true })).toMatchObject({ ok: true })
    expect(oauthOf(vault.readSecret(ADDON_SERVICE, 'ad_a'))).toMatchObject({ accessToken: 'NEWER', expiresAt: far })
  })

  it('a host that lost the grant mid-refresh keeps no refresh token', async () => {
    const fetch = tokenServer(async () => {
      const p = vault.profiles(ADDON_SERVICE)[0]
      vault.upsertProfile(ADDON_SERVICE, { ...p, owner: 'env_other' })
      return jsonResponse({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 600 })
    })
    core({ fetch, environmentId: 'env_box' })
    ownedHere(grant({ expiresAt: Date.now() - 1 }))
    const out = await refreshAddon('ad_a')
    expect(out.ok && sync.hasRefresh(ADDON_SERVICE, out.blob)).toBe(false)
  })
})

describe('saveAddonGrant', () => {
  it('a grant without oauth is static and ownerless; one with oauth keeps its row owner unless signed in here', () => {
    core({ environmentId: 'env_mac' })
    expect(saveAddonGrant({ addonId: 'ad_a', nickname: 'Mobbin', blob: grant(null, { K: 'v' }) })).toBe('ad_a')
    expect(vault.profiles(ADDON_SERVICE)[0]).toMatchObject({ name: 'ad_a', accountId: 'ad_a', nickname: 'Mobbin', static: true })
    expect(vault.profiles(ADDON_SERVICE)[0].owner).toBeUndefined()
    // An access copy owned by the box, then values saved here: the owner stays.
    vault.upsertProfile(ADDON_SERVICE, { ...vault.profiles(ADDON_SERVICE)[0], static: false, owner: 'env_box', syncedAt: 9 })
    saveAddonGrant({ addonId: 'ad_a', nickname: 'Mobbin', blob: grant({ refreshToken: undefined }, { K: 'w' }) })
    expect(vault.profiles(ADDON_SERVICE)[0]).toMatchObject({ static: false, owner: 'env_box', syncedAt: 9 })
    // A sign-in that completed here makes this host the owner.
    saveAddonGrant({ addonId: 'ad_a', nickname: 'Mobbin', blob: grant({}, { K: 'w' }), signedIn: true })
    const row = vault.profiles(ADDON_SERVICE)[0]
    expect(row.owner).toBeUndefined()
    expect(row.syncedAt).toBeUndefined()
    expect(sync.ownsProfile(row)).toBe(true)
    expect(() => saveAddonGrant({ addonId: 'ad_b', nickname: 'b', blob: grant(null) })).toThrow(/not a grant of the add-on ad_b/)
  })

  it('saves with origin local and fires no accounts change', () => {
    const onSecretSaved = vi.fn()
    const onAccountsChanged = vi.fn()
    core({ hooks: { onSecretSaved, onAccountsChanged } })
    saveAddonGrant({ addonId: 'ad_a', nickname: 'a', blob: grant(null) })
    expect(onSecretSaved).toHaveBeenCalledWith(ADDON_SERVICE, 'ad_a', 'local')
    expect(onAccountsChanged).not.toHaveBeenCalled()
  })

  it("an older reader's whole-file rewrite of profiles.json keeps the addon key", () => {
    const dataDir = core()
    saveAddonGrant({ addonId: 'ad_a', nickname: 'a', blob: grant(null) })
    // The old Aliax core: read the whole object, change one service, write it whole.
    const file = join(dataDir, 'profiles.json')
    const whole = JSON.parse(readFileSync(file, 'utf8'))
    whole['claude-code'] = [{ name: 'c', accountId: 'u', createdAt: 1 }]
    writeFileSync(file, JSON.stringify(whole))
    expect(vault.profiles(ADDON_SERVICE).map((p) => p.name)).toEqual(['ad_a'])
  })
})
