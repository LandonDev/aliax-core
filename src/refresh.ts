import { refreshAuth as refreshCodexGrant } from './adapters/codex'
import type { RefreshBlob } from './adapters/types'
import { fetch, hooks, role } from './config'
import { CLAUDE_CLIENT_ID, CLAUDE_TOKEN_URL } from './oauth'
import type { ServiceId } from './shared/types'
import { accessExpiry, isStaticBlob, ownsProfile, profileOf } from './sync'
import * as vault from './vault'

/** Refresh a minute before expiry, so a long turn cannot start on a dead token. */
export const EXPIRY_MARGIN_MS = 60_000

/**
 * One refresh at a time per profile, shared by the gateway and the usage poll.
 * Rotating refresh tokens invalidate their predecessor, so two concurrent
 * refreshes of the same grant would present the same token twice and get it
 * revoked (invariant 12). A second caller joins the first's promise and gets
 * its result. Different profiles hold different grants and may refresh side
 * by side.
 */
const refreshing = new Map<string, Promise<unknown>>()

export function once<T>(serviceId: ServiceId, name: string, work: () => Promise<T>): Promise<T> {
  const key = `${serviceId}:${name}`
  const existing = refreshing.get(key)
  if (existing) return existing as Promise<T>
  const p = work().finally(() => refreshing.delete(key))
  refreshing.set(key, p)
  return p
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
    vault.saveSecret('claude-code', name, out)
    return out
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
    vault.saveSecret('codex', name, next)
    return next
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
