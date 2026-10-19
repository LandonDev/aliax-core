import { decodeJwtPayload } from './adapters/types'
import { environmentId } from './config'
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

export type ApplyOutcome =
  | { ok: true; name: string; saved: boolean; owner: string | null; expiresAt: number | null }
  | { ok: false; reason: 'no-environment' | 'not-for-us' | 'owner-mismatch' | 'static' | 'bad-blob' }

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
 * Land a transfer another environment sent. Idempotent: the same transfer
 * twice saves once; an older one saves nothing and still answers ok, so the
 * sender can finish its side (strip its refresh token after a handoff).
 */
export function applyTransfer(t: Transfer): ApplyOutcome {
  const me = environmentId()
  if (!me) return { ok: false, reason: 'no-environment' }
  if (!parse(t.blob)) return { ok: false, reason: 'bad-blob' }
  const existing = matchProfile(t.service, t.profile)
  const name = existing?.name ?? t.profile.name
  let stored: string | null = null
  try {
    stored = existing ? vault.readSecret(t.service, existing.name) : null
  } catch {
    // an undecryptable copy on file: the incoming one can only improve things
  }
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
    vault.upsertProfile(t.service, { ...base, static: isStatic, owner: owner ?? undefined, syncedAt: now })
    return { ok: true, name, saved, owner, expiresAt: accessExpiry(t.service, saved ? blob : stored!) }
  }
  if (t.profile.static) return land(t.blob, null, true)
  if (existing?.static) return { ok: false, reason: 'static' }
  if (t.mode === 'handoff') {
    if (t.profile.owner !== me) return { ok: false, reason: 'not-for-us' }
    if (!hasRefresh(t.service, t.blob)) return { ok: false, reason: 'bad-blob' }
    return land(t.blob, me, false)
  }
  // An access copy: from the owner, to a host that does not think it owns the grant.
  if (!t.profile.owner || t.profile.owner === me) return { ok: false, reason: 'owner-mismatch' }
  if (existing && ownsProfile(existing)) return { ok: false, reason: 'owner-mismatch' }
  return land(stripRefresh(t.service, t.blob), t.profile.owner, false)
}

/** The sender's half of a confirmed handoff: keep an access-only copy that follows `owner` from now on. */
export function confirmHandoff(serviceId: ServiceId, name: string, owner: string): void {
  const p = profileOf(serviceId, name)
  if (!p) return
  const stored = vault.readSecret(serviceId, name)
  if (stored) vault.saveSecret(serviceId, name, stripRefresh(serviceId, stored), 'sync')
  vault.upsertProfile(serviceId, { ...p, static: false, owner, syncedAt: Date.now() })
}

/** The owner's half of a take-over: the full grant for `to`, after which this host holds an access-only copy. */
export function releaseTo(serviceId: ServiceId, name: string, to: string): Transfer {
  const t = exportAccount(serviceId, name, 'handoff', to)
  confirmHandoff(serviceId, name, to)
  return t
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
