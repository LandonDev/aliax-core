import { createHash } from 'node:crypto'
import { decodeJwtPayload } from './adapters/types'
import { environmentId } from './config'
import { acquire } from './lock'
import type { ServiceId } from './shared/types'
import * as vault from './vault'
import type { StoredProfile } from './vault'

/**
 * One account on several machines (temp-code's Mac and its Linux box).
 *
 * Refresh tokens rotate on every use at both providers, and a rotation
 * revokes the token it replaced, so a grant can have exactly one refresher.
 * The rules, all enforced here or in refresh.ts:
 *  - every profile has one owner, named by environment id; the owner alone
 *    presents the refresh token (`owner` absent means this machine)
 *  - anyone else holds an access-only copy, pushed by the owner on every
 *    rotation, and asks the owner for a fresh one near its end
 *  - a static profile (a long-lived bearer from `claude setup-token`) has
 *    no refresh token and no owner; every host holds the same copy
 *  - a copy never goes backwards: a transfer lands only when its access
 *    token outlives the one on file, by the token's own expiry
 *  - a handoff is two-phase, and the grant has one refresher throughout:
 *    the sender exports under the profile's lock (lock.ts), the receiver
 *    saves the grant PROVISIONALLY (owner still the sender, so nothing
 *    there refreshes it) and answers with the fingerprint of the refresh
 *    token it saved; the sender strips its own copy only on an answer that
 *    echoes the fingerprint of what it sent, then tells the receiver, which
 *    makes itself the owner. A lost answer leaves the sender refreshing and
 *    the receiver with an inert copy; a lost notice leaves the receiver
 *    inert until it asks; both settle on the next sync (temp-code's
 *    accountSync.ts carries the messages)
 */

type Parsed = Record<string, any>

const parse = (blob: string): Parsed | null => {
  try {
    const v = JSON.parse(blob)
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

const claudeTokens = (parsed: Parsed): Parsed | null =>
  typeof parsed.keychain === 'string' ? (parse(parsed.keychain)?.claudeAiOauth ?? null) : null

const jwtExpiry = (token: unknown): number | null => {
  if (typeof token !== 'string') return null
  try {
    const exp = decodeJwtPayload(token).exp
    return typeof exp === 'number' ? exp * 1000 : null
  } catch {
    return null
  }
}

/** When the blob's access token lapses, ms since the epoch; null when it says nothing. */
export function accessExpiry(serviceId: ServiceId, blob: string): number | null {
  const parsed = parse(blob)
  if (!parsed) return null
  if (serviceId === 'claude-code') {
    const exp = claudeTokens(parsed)?.expiresAt
    return typeof exp === 'number' ? exp : null
  }
  if (serviceId === 'codex') return jwtExpiry(parsed.tokens?.access_token)
  return jwtExpiry(parsed.access)
}

/** Whether the blob can renew itself: it carries a refresh token. */
export function hasRefresh(serviceId: ServiceId, blob: string): boolean {
  const parsed = parse(blob)
  if (!parsed) return false
  if (serviceId === 'claude-code') return typeof claudeTokens(parsed)?.refreshToken === 'string'
  if (serviceId === 'codex') return typeof parsed.tokens?.refresh_token === 'string'
  return typeof parsed.refresh === 'string'
}

/** The same blob without its refresh token: what anyone but the owner may hold. */
export function stripRefresh(serviceId: ServiceId, blob: string): string {
  const parsed = parse(blob)
  if (!parsed) return blob
  if (serviceId === 'claude-code') {
    const keychain = typeof parsed.keychain === 'string' ? parse(parsed.keychain) : null
    if (keychain?.claudeAiOauth && typeof keychain.claudeAiOauth === 'object') {
      delete keychain.claudeAiOauth.refreshToken
      delete keychain.claudeAiOauth.refreshTokenExpiresAt
      parsed.keychain = JSON.stringify(keychain)
    }
  } else if (serviceId === 'codex') {
    if (parsed.tokens && typeof parsed.tokens === 'object') delete parsed.tokens.refresh_token
  } else {
    delete parsed.refresh
  }
  return JSON.stringify(parsed)
}

const refreshTokenOf = (serviceId: ServiceId, blob: string): string | null => {
  const parsed = parse(blob)
  if (!parsed) return null
  const token =
    serviceId === 'claude-code' ? claudeTokens(parsed)?.refreshToken : serviceId === 'codex' ? parsed.tokens?.refresh_token : parsed.refresh
  return typeof token === 'string' ? token : null
}

/**
 * A short digest of the blob's refresh token, safe to log and to send: what
 * a handoff's answer echoes so the sender knows the receiver saved the very
 * grant it sent. Null when the blob holds no refresh token.
 */
export function refreshFingerprint(serviceId: ServiceId, blob: string): string | null {
  const token = refreshTokenOf(serviceId, blob)
  return token ? createHash('sha256').update(token).digest('hex').slice(0, 16) : null
}

/** What may leave this machine: never the desktop app's cookies, which only this Mac's app can use. */
export function forTransfer(serviceId: ServiceId, blob: string): string {
  if (serviceId !== 'claude-code') return blob
  const parsed = parse(blob)
  if (!parsed) return blob
  delete parsed.appSession
  return JSON.stringify(parsed)
}

/** A blob saved by saveStaticClaude: a bearer nothing refreshes. */
export const isStaticBlob = (blob: string): boolean => parse(blob)?.tokenKind === 'static'

/**
 * Whether this environment refreshes the profile's grant. A profile with no
 * owner is this machine's (every profile before ownership existed); a static
 * profile is nobody's.
 */
export function ownsProfile(p: Pick<StoredProfile, 'owner' | 'static'>): boolean {
  if (p.static) return false
  if (p.owner === undefined) return true
  return p.owner === environmentId()
}

export const profileOf = (serviceId: ServiceId, name: string): StoredProfile | null =>
  vault.profiles(serviceId).find((p) => p.name === name) ?? null

const storedOf = (serviceId: ServiceId, name: string): string | null => {
  try {
    return vault.readSecret(serviceId, name)
  } catch {
    return null
  }
}

/**
 * A grant another host handed this one that this host has not yet been told
 * to refresh: the blob carries a refresh token, the row still names the
 * sender. Inert until claimHandoff; the sender's next word settles it.
 */
export function isProvisional(serviceId: ServiceId, p: Pick<StoredProfile, 'name' | 'owner' | 'static'>): boolean {
  if (p.static || ownsProfile(p)) return false
  const stored = storedOf(serviceId, p.name)
  return stored !== null && hasRefresh(serviceId, stored)
}

export type TransferMode = 'handoff' | 'access'

export interface TransferProfile {
  name: string
  accountId: string
  email?: string
  nickname?: string
  color?: string
  createdAt: number
  static: boolean
  /** Who refreshes the grant: the new owner of a handoff, the sender of an access copy, null for a static token. */
  owner: string | null
}

/** One account as it crosses to another environment. */
export interface Transfer {
  service: ServiceId
  mode: TransferMode
  profile: TransferProfile
  blob: string
  expiresAt: number | null
}

const transferProfile = (p: StoredProfile, owner: string | null): TransferProfile => ({
  name: p.name,
  accountId: p.accountId,
  email: p.email,
  nickname: p.nickname,
  color: p.color,
  createdAt: p.createdAt,
  static: p.static === true,
  owner
})

/**
 * What to send another environment for one account. A `handoff` carries the
 * refresh token and names `to` as the new owner; an `access` transfer carries
 * none and names this environment as the one to ask. Only the owner sends
 * either; a static profile goes as it is, with no owner.
 */
export function exportAccount(serviceId: ServiceId, name: string, mode: TransferMode, to?: string): Transfer {
  const p = profileOf(serviceId, name)
  if (!p) throw new Error(`no saved account "${name}"`)
  const stored = vault.readSecret(serviceId, name)
  if (!stored) throw new Error(`"${name}" has no credentials saved`)
  const blob = forTransfer(serviceId, stored)
  const expiresAt = accessExpiry(serviceId, blob)
  if (p.static) return { service: serviceId, mode: 'access', profile: transferProfile(p, null), blob, expiresAt }
  if (!ownsProfile(p)) throw new Error(`"${name}" is refreshed by ${p.owner}; only the owner shares it`)
  if (mode === 'handoff') {
    if (!to) throw new Error('a handoff names the new owner')
    if (!hasRefresh(serviceId, blob)) throw new Error(`"${name}" holds no refresh token to hand off`)
    return { service: serviceId, mode, profile: transferProfile(p, to), blob, expiresAt }
  }
  const me = environmentId()
  if (!me) throw new Error('this host has no environment id for others to ask')
  return { service: serviceId, mode: 'access', profile: transferProfile(p, me), blob: stripRefresh(serviceId, blob), expiresAt }
}

/**
 * Who may send what. `admin`: the sender holds an admin key of this host
 * (it pairs and manages this host), so an account this host never had may
 * arrive. `peer`: the sender is a host this machine holds a key FOR; what
 * it sends must concern an account already on file here, matched by id or
 * email, so a peer cannot plant an account this host never paired or owned.
 */
export type ApplyPolicy = 'admin' | 'peer'

export type ApplyOutcome =
  | {
      ok: true
      name: string
      saved: boolean
      /** The row's owner after the apply: the sender for a handoff until claimHandoff, null for a static token. */
      owner: string | null
      expiresAt: number | null
      /** Of the refresh token on file after the apply; the sender of a handoff compares it with what it sent. */
      refreshFingerprint: string | null
    }
  | {
      ok: false
      reason:
        | 'no-environment'
        | 'not-for-us'
        | 'owner-mismatch'
        | 'static'
        | 'bad-blob'
        /** A handoff older than the access token on file, with no refresh token here to fall back on: nothing changed. */
        | 'stale'
        /** This host holds a grant another sender handed it and has not settled yet. */
        | 'provisional'
        /** Under the peer policy: no row for this account here. */
        | 'unknown-account'
        /** An access copy must name its sender as the owner. */
        | 'not-owner'
    }

function matchProfile(serviceId: ServiceId, incoming: TransferProfile): StoredProfile | undefined {
  const list = vault.profiles(serviceId)
  return (
    list.find((p) => p.accountId === incoming.accountId) ??
    (incoming.email ? list.find((p) => p.email?.toLowerCase() === incoming.email!.toLowerCase()) : undefined)
  )
}

/** Whether `incoming` may replace what is on file: never an older access token. */
function fresher(serviceId: ServiceId, stored: string | null, incoming: string): boolean {
  if (!stored) return true
  const was = accessExpiry(serviceId, stored)
  const next = accessExpiry(serviceId, incoming)
  if (next === null) return was === null
  return was === null || next >= was
}

/**
 * Land a transfer `from` another environment sent. Idempotent: the same
 * transfer twice saves once; an older access copy saves nothing and still
 * answers ok. A handoff lands provisionally (the row keeps naming `from`,
 * so nothing here refreshes the grant until claimHandoff) and answers with
 * the fingerprint of the refresh token now on file: an older handoff lands
 * only when this host holds no refresh token to lose, otherwise it is
 * refused as stale, so the sender never strips its copy for a grant that
 * nobody saved.
 */
export function applyTransfer(t: Transfer, from: string, policy: ApplyPolicy = 'admin'): ApplyOutcome {
  const me = environmentId()
  if (!me) return { ok: false, reason: 'no-environment' }
  if (!parse(t.blob)) return { ok: false, reason: 'bad-blob' }
  const existing = matchProfile(t.service, t.profile)
  if (policy === 'peer' && !existing) return { ok: false, reason: 'unknown-account' }
  const name = existing?.name ?? t.profile.name
  const stored = existing ? storedOf(t.service, existing.name) : null // undecryptable reads as nothing on file
  const base: StoredProfile = {
    ...existing,
    name,
    accountId: t.profile.accountId,
    email: t.profile.email ?? existing?.email,
    nickname: existing?.nickname ?? t.profile.nickname,
    color: existing?.color ?? t.profile.color,
    createdAt: existing?.createdAt ?? t.profile.createdAt
  }
  const now = Date.now()
  const land = (blob: string, owner: string | null, isStatic: boolean): ApplyOutcome => {
    const saved = fresher(t.service, stored, blob)
    if (saved) vault.saveSecret(t.service, name, blob, 'sync')
    const row: StoredProfile = { ...base, static: isStatic, owner: owner ?? undefined, syncedAt: now }
    delete row.releasedAt
    vault.upsertProfile(t.service, row)
    const held = saved ? blob : stored!
    return { ok: true, name, saved, owner, expiresAt: accessExpiry(t.service, held), refreshFingerprint: refreshFingerprint(t.service, held) }
  }
  if (t.profile.static) {
    if (policy === 'peer' && !existing?.static) return { ok: false, reason: 'unknown-account' }
    return land(t.blob, null, true)
  }
  if (existing?.static) return { ok: false, reason: 'static' }
  if (t.mode === 'handoff') {
    if (t.profile.owner !== me) return { ok: false, reason: 'not-for-us' }
    if (!hasRefresh(t.service, t.blob)) return { ok: false, reason: 'bad-blob' }
    if (!fresher(t.service, stored, t.blob)) {
      // Older than the access token here. With a refresh token on file the
      // grant is safe either way and the answer names it; without one,
      // accepting would leave the sender stripping its only copy.
      if (!stored || !hasRefresh(t.service, stored)) return { ok: false, reason: 'stale' }
      return { ok: true, name, saved: false, owner: existing?.owner ?? null, expiresAt: accessExpiry(t.service, stored), refreshFingerprint: refreshFingerprint(t.service, stored) }
    }
    return land(t.blob, from, false)
  }
  // An access copy: from the owner, to a host that does not think it owns the grant.
  if (!t.profile.owner || t.profile.owner === me) return { ok: false, reason: 'owner-mismatch' }
  if (t.profile.owner !== from) return { ok: false, reason: 'not-owner' }
  if (existing && ownsProfile(existing)) return { ok: false, reason: 'owner-mismatch' }
  // A grant handed here by someone else is still being settled; the owner's
  // own access copy says it kept the grant, which voids the copy from it.
  if (existing && stored && hasRefresh(t.service, stored) && existing.owner !== from) return { ok: false, reason: 'provisional' }
  return land(stripRefresh(t.service, t.blob), t.profile.owner, false)
}

/**
 * The receiver's last step: the sender stripped its copy, so the grant it
 * handed over (saved provisionally by applyTransfer) is this host's to
 * refresh from now on. True when the row now says so, including when it
 * already did; false when there is no such grant here (the sender's word
 * must then be reconciled by its own copy, never by inventing one).
 */
export function claimHandoff(serviceId: ServiceId, name: string, from: string): boolean {
  const me = environmentId()
  const p = profileOf(serviceId, name)
  if (!me || !p || p.static) return false
  const stored = storedOf(serviceId, name)
  if (!stored || !hasRefresh(serviceId, stored)) return false
  if (p.owner === me) return true
  if (p.owner !== from) return false
  vault.upsertProfile(serviceId, { ...p, owner: me, syncedAt: Date.now() })
  return true
}

/**
 * The sender's half of a confirmed handoff: keep an access-only copy that
 * follows `owner` from now on, and remember the release until the new owner
 * has been told (releasedAt; clearReleased once it has).
 */
export function confirmHandoff(serviceId: ServiceId, name: string, owner: string): void {
  const p = profileOf(serviceId, name)
  if (!p) return
  const stored = vault.readSecret(serviceId, name)
  if (stored) vault.saveSecret(serviceId, name, stripRefresh(serviceId, stored), 'sync')
  vault.upsertProfile(serviceId, { ...p, static: false, owner, syncedAt: Date.now(), releasedAt: Date.now() })
}

/** The new owner has been told: nothing left to say about this release. */
export function clearReleased(serviceId: ServiceId, name: string): void {
  const p = profileOf(serviceId, name)
  if (!p || p.releasedAt === undefined) return
  const row = { ...p }
  delete row.releasedAt
  vault.upsertProfile(serviceId, row)
}

export interface Handoff {
  transfer: Transfer
  /** Of the refresh token in `transfer`; an answer must echo it before commit. */
  fingerprint: string
  /** The receiver saved the grant: strip this host's copy and release the lock. */
  commit: () => void
  /** No proof the receiver saved it: keep refreshing here and release the lock. */
  abort: () => void
}

/**
 * Start handing a grant to `to`: take the profile's lock (an in-flight
 * refresh finishes first, none starts until commit or abort), export the
 * full grant, and hand back the two ways out. The caller sends the transfer,
 * compares the answer's fingerprint with `fingerprint`, and commits only on
 * a match. Nothing may be left open: a pending release times out to abort.
 */
export async function beginHandoff(serviceId: ServiceId, name: string, to: string): Promise<Handoff> {
  const release = await acquire(serviceId, name)
  let transfer: Transfer
  try {
    transfer = exportAccount(serviceId, name, 'handoff', to)
  } catch (err) {
    release()
    throw err
  }
  let done = false
  const finish = (): void => {
    if (done) return
    done = true
    release()
  }
  return {
    transfer,
    fingerprint: refreshFingerprint(serviceId, transfer.blob)!,
    commit: () => {
      if (!done) confirmHandoff(serviceId, name, to)
      finish()
    },
    abort: finish
  }
}

export function markSynced(serviceId: ServiceId, name: string): void {
  const p = profileOf(serviceId, name)
  if (p) vault.upsertProfile(serviceId, { ...p, syncedAt: Date.now() })
}

export interface StaticClaudeToken {
  token: string
  expiresAt: number
  accountId: string
  email?: string
  scopes?: string[]
  organizationUuid?: string
  organizationName?: string
}

/**
 * Save a `claude setup-token` bearer as a static profile. The account's
 * existing row (matched by id, then email) keeps its colour, nickname,
 * identity and desktop-app session; only the credential changes, and from
 * now on nothing refreshes it. Returns the profile name.
 */
export function saveStaticClaude(input: StaticClaudeToken): string {
  const list = vault.profiles('claude-code')
  const existing =
    list.find((p) => p.accountId === input.accountId) ??
    (input.email ? list.find((p) => p.email?.toLowerCase() === input.email!.toLowerCase()) : undefined)
  const name = existing?.name ?? input.email ?? `account-${list.length + 1}`
  let prior: Parsed | null = null
  if (existing) {
    try {
      const stored = vault.readSecret('claude-code', existing.name)
      prior = stored ? parse(stored) : null
    } catch {
      prior = null
    }
  }
  const keychain = JSON.stringify({
    claudeAiOauth: { accessToken: input.token, expiresAt: input.expiresAt, scopes: input.scopes ?? ['user:inference'] }
  })
  const oauthAccount = prior?.oauthAccount ?? {
    accountUuid: input.accountId,
    emailAddress: input.email,
    organizationUuid: input.organizationUuid,
    organizationName: input.organizationName
  }
  vault.saveSecret(
    'claude-code',
    name,
    JSON.stringify({ keychain, oauthAccount, appSession: prior?.appSession ?? null, tokenKind: 'static' })
  )
  vault.upsertProfile('claude-code', {
    ...existing,
    name,
    accountId: input.accountId,
    email: input.email ?? existing?.email,
    createdAt: existing?.createdAt ?? Date.now(),
    static: true,
    owner: undefined,
    syncedAt: undefined
  })
  return name
}
