import { addonGrantOf } from './adapters/addon'
import { refreshAuth as refreshCodexGrant } from './adapters/codex'
import type { RefreshBlob } from './adapters/types'
import { fetch, hooks, role } from './config'
import { CLAUDE_CLIENT_ID, CLAUDE_TOKEN_URL } from './oauth'
import type { ServiceId } from './shared/types'
import { withLock } from './lock'
import { accessExpiry, isStaticBlob, ownsProfile, profileOf, stripRefresh } from './sync'
import * as vault from './vault'

/** Refresh a minute before expiry, so a long turn cannot start on a dead token. */
export const EXPIRY_MARGIN_MS = 60_000

/**
 * One refresh at a time per profile, shared by the gateway and the usage poll.
 * Rotating refresh tokens invalidate their predecessor, so two concurrent
 * refreshes of the same grant would present the same token twice and get it
 * revoked (invariant 12). A second caller joins the first's promise and gets
 * its result. The work runs under the profile's lock (lock.ts), the same one
 * a handoff holds across its round trip, so a refresh and a change of owner
 * never interleave. Different profiles hold different grants and may refresh
 * side by side.
 */
const refreshing = new Map<string, Promise<unknown>>()

export function once<T>(serviceId: ServiceId, name: string, work: () => Promise<T>): Promise<T> {
  const key = `${serviceId}:${name}`
  const existing = refreshing.get(key)
  if (existing) return existing as Promise<T>
  const p = withLock(serviceId, name, work).finally(() => refreshing.delete(key))
  refreshing.set(key, p)
  return p
}

/**
 * The save after a token endpoint answered. The lock keeps a handoff from
 * running meanwhile, but ownership is read again all the same: a refresh
 * token is never written into a vault this host no longer refreshes for
 * (the former owner after a handoff holds an access-only copy, and a
 * provisional copy of an incoming grant is left as it is). In that case
 * the fresh access token serves the caller once and the vault stays as the
 * sync left it.
 */
function saveRefreshed(serviceId: ServiceId, name: string, next: string): string {
  const profile = profileOf(serviceId, name)
  if (profile && !ownsProfile(profile)) return stripRefresh(serviceId, next)
  vault.saveSecret(serviceId, name, next)
  return next
}

function storedBlob(serviceId: ServiceId, name: string): string | null {
  try {
    return vault.readSecret(serviceId, name)
  } catch {
    return null
  }
}

/**
 * A copy owned by another environment never presents a refresh token: the
 * host asks the owner for a fresh access-only copy, lands it (sync.ts
 * applyTransfer) and answers with what the vault now holds. No host hook,
 * or an owner out of reach, means nothing changes and the caller serves the
 * token it has for as long as it lasts.
 */
async function askOwner(serviceId: ServiceId, name: string, owner: string): Promise<string | null> {
  const ask = hooks().askOwner
  if (!ask) return null
  return (await ask(serviceId, name, owner).catch(() => null)) ?? null
}

type ClaudeTokens = { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown }

function parseClaude(blob: string): { parsed: Record<string, unknown>; tokens: ClaudeTokens } {
  try {
    const parsed = JSON.parse(blob) as Record<string, unknown>
    const tokens = typeof parsed.keychain === 'string' ? (JSON.parse(parsed.keychain)?.claudeAiOauth ?? {}) : {}
    return { parsed, tokens }
  } catch {
    return { parsed: {}, tokens: {} }
  }
}

const claudeExpiry = (blob: string | null): number => (blob ? (accessExpiry('claude-code', blob) ?? 0) : 0)

/**
 * Renew one stored Claude profile and return the new blob, or null when the
 * grant could not be renewed. `blob` is the copy the caller holds, which may
 * be stale: the vault is re-read under the lock, and when it already holds a
 * fresher token outside the expiry margin that copy is returned with no
 * network call. A static token (claude setup-token) is never renewed; a copy
 * another environment owns is renewed by asking that owner, never by the
 * token endpoint. Otherwise the POST presents the VAULT's refresh token (the
 * caller's may have been rotated past), everything else in the stored blob
 * (oauthAccount, appSession) is kept, and the save never goes backwards by
 * the token's own expiry, the same rule as saveSecretUnlessOlder.
 */
export function refreshClaude(name: string, blob: string): Promise<string | null> {
  return once('claude-code', name, async () => {
    const stored = storedBlob('claude-code', name)
    const current = stored ?? blob
    if (stored && claudeExpiry(stored) > claudeExpiry(blob) && claudeExpiry(stored) - Date.now() > EXPIRY_MARGIN_MS) return stored
    const profile = profileOf('claude-code', name)
    if (profile?.static || isStaticBlob(current)) return null
    if (profile && !ownsProfile(profile)) return askOwner('claude-code', name, profile.owner ?? '')
    const { parsed, tokens } = parseClaude(current)
    if (typeof tokens.refreshToken !== 'string') return null
    const res = await fetch(CLAUDE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken, client_id: CLAUDE_CLIENT_ID })
    }).catch(() => null)
    if (!res?.ok) return null
    const data = (await res.json().catch(() => null)) as { access_token?: string; refresh_token?: string; expires_in?: number } | null
    if (!data?.access_token) return null
    const next = {
      ...tokens,
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? tokens.refreshToken,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000
    }
    const out = JSON.stringify({ ...parsed, keychain: JSON.stringify({ claudeAiOauth: next }) })
    const latest = storedBlob('claude-code', name)
    if (latest && claudeExpiry(latest) > next.expiresAt) return latest
    return saveRefreshed('claude-code', name, out)
  })
}

/**
 * The same for a stored Codex profile: one lock, the vault re-read under it,
 * the owner alone presenting the refresh token (a copy owned elsewhere asks
 * its owner), and never a save that goes backwards by the access token's
 * expiry. The gateway and the usage poll both come through here.
 */
export function refreshCodex(name: string, blob: string): Promise<string | null> {
  return once('codex', name, async () => {
    const stored = storedBlob('codex', name)
    const current = stored ?? blob
    const storedAt = stored ? accessExpiry('codex', stored) : null
    const blobAt = accessExpiry('codex', blob)
    if (stored && storedAt !== null && (blobAt === null || storedAt > blobAt) && storedAt - Date.now() > EXPIRY_MARGIN_MS) return stored
    const profile = profileOf('codex', name)
    if (profile && !ownsProfile(profile)) return askOwner('codex', name, profile.owner ?? '')
    const next = await refreshCodexGrant(current)
    if (!next) return null
    const latest = storedBlob('codex', name)
    const latestAt = latest ? accessExpiry('codex', latest) : null
    const nextAt = accessExpiry('codex', next)
    if (latest && latestAt !== null && nextAt !== null && latestAt > nextAt) return latest
    return saveRefreshed('codex', name, next)
  })
}

export type AddonRefresh =
  | { ok: true; blob: string }
  | { ok: false; reason: 'no-grant' | 'static' | 'no-refresh' | 'refused' | 'network' | 'owner-unreachable' }

/**
 * Renew one add-on grant's access token (temp-code's add-on OAuth), under
 * `once`, the profile lock a handoff also holds. The vault is re-read under
 * the lock; unless `force`, a stored token with more than `minValidMs` left
 * (default EXPIRY_MARGIN_MS) is returned as it is, on the owner and on a
 * copy alike (`force` on a copy always asks the owner, so a token the server
 * just refused is never handed back from this vault). A static profile has
 * nothing to renew. A copy another environment owns asks that owner
 * (hooks().askOwner). Otherwise the stored refresh token is POSTed to the
 * grant's token endpoint, form-encoded. After the answer the profile and the
 * blob are read again: a profile that went meanwhile saves nothing (a clear
 * ran), the new tokens go onto the LATEST blob's oauth section (values saved
 * meanwhile stay), a save never goes backwards over a token saved during
 * the request (a shorter-lived answer is still saved: its refresh token is
 * the only one left), and it
 * goes through saveRefreshed, so a host that lost the grant mid-refresh keeps
 * no refresh token. No role gate: only temp-code knows add-on grants, and
 * ownership is the one rule.
 */
export function refreshAddon(name: string, opts: { force?: boolean; minValidMs?: number } = {}): Promise<AddonRefresh> {
  return once('addon', name, async (): Promise<AddonRefresh> => {
    const profile = profileOf('addon', name)
    const stored = storedBlob('addon', name)
    if (!profile || !stored) return { ok: false, reason: 'no-grant' }
    if (profile.static) return { ok: false, reason: 'static' }
    const grant = addonGrantOf(stored)
    if (!grant) return { ok: false, reason: 'no-grant' }
    if (!grant.oauth) return { ok: false, reason: 'static' }
    const minValidMs = opts.minValidMs ?? EXPIRY_MARGIN_MS
    const expiresAt = grant.oauth.expiresAt
    if (!opts.force && grant.oauth.accessToken && typeof expiresAt === 'number' && expiresAt - Date.now() > minValidMs) return { ok: true, blob: stored }
    if (!ownsProfile(profile)) {
      const blob = await askOwner('addon', name, profile.owner ?? '')
      return blob ? { ok: true, blob } : { ok: false, reason: 'owner-unreachable' }
    }
    const refreshToken = grant.oauth.refreshToken
    if (!refreshToken) return { ok: false, reason: 'no-refresh' }
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: grant.oauth.clientId })
    if (grant.oauth.clientSecret) body.set('client_secret', grant.oauth.clientSecret)
    if (grant.oauth.resource) body.set('resource', grant.oauth.resource)
    const res = await fetch(grant.oauth.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString()
    }).catch(() => null)
    if (!res) return { ok: false, reason: 'network' }
    if (res.status === 400 || res.status === 401) return { ok: false, reason: 'refused' }
    if (!res.ok) return { ok: false, reason: 'network' }
    const data = (await res.json().catch(() => null)) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown } | null
    if (!data || typeof data.access_token !== 'string' || !data.access_token) return { ok: false, reason: 'network' }
    const latestProfile = profileOf('addon', name)
    const latest = storedBlob('addon', name)
    const latestGrant = latest ? addonGrantOf(latest) : null
    if (!latestProfile || !latest || !latestGrant) return { ok: false, reason: 'no-grant' }
    const nextExpiry = typeof data.expires_in === 'number' && data.expires_in > 0 ? Date.now() + data.expires_in * 1000 : undefined
    // Never backwards, but only over a token saved during the request: the refresh token just
    // presented is spent, so the pair that came back is the grant even when it lapses sooner.
    const latestExpiry = latestGrant.oauth?.expiresAt
    const savedMeanwhile = latestGrant.oauth?.refreshToken !== refreshToken || latestGrant.oauth?.accessToken !== grant.oauth.accessToken
    if (savedMeanwhile && typeof latestExpiry === 'number' && nextExpiry !== undefined && latestExpiry > nextExpiry) return { ok: true, blob: latest }
    const oauth = {
      ...(latestGrant.oauth ?? grant.oauth),
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : refreshToken
    }
    if (nextExpiry !== undefined) oauth.expiresAt = nextExpiry
    else delete oauth.expiresAt
    if (typeof data.scope === 'string' && data.scope) oauth.scope = data.scope
    return { ok: true, blob: saveRefreshed('addon', name, JSON.stringify({ ...latestGrant, oauth })) }
  })
}

/**
 * The callback that renews one profile's stored copy for an adapter's usage
 * poll, or null when this app must not: a standby app (the gateway owner on
 * this machine refreshes, one refresher per machine), or a service that
 * renews nothing itself (Cursor's IDE keeps its own tokens).
 */
export function refreshFor(serviceId: ServiceId, name: string): RefreshBlob | null {
  if (role() !== 'owner') return null
  if (serviceId === 'claude-code') return (b) => refreshClaude(name, b)
  if (serviceId === 'codex') return (b) => refreshCodex(name, b)
  return null
}
