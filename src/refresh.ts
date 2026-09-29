import { fetch } from './config'
import { CLAUDE_CLIENT_ID, CLAUDE_TOKEN_URL } from './oauth'
import type { ServiceId } from './shared/types'
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

const expiryOf = (blob: string | null): number => {
  const exp = blob ? parseClaude(blob).tokens.expiresAt : undefined
  return typeof exp === 'number' ? exp : 0
}

function storedBlob(name: string): string | null {
  try {
    return vault.readSecret('claude-code', name)
  } catch {
    return null
  }
}

/**
 * Renew one stored Claude profile and return the new blob, or null when the
 * grant could not be renewed. `blob` is the copy the caller holds, which may
 * be stale: the vault is re-read under the lock, and when it already holds a
 * fresher token outside the expiry margin that copy is returned with no
 * network call. The POST always presents the VAULT's refresh token — the
 * caller's may have been rotated past. Everything else in the stored blob
 * (oauthAccount, appSession) is kept, and the save never goes backwards by
 * the token's own expiry, the same rule as saveSecretUnlessOlder.
 */
export function refreshClaude(name: string, blob: string): Promise<string | null> {
  return once('claude-code', name, async () => {
    const stored = storedBlob(name)
    const current = stored ?? blob
    if (stored && expiryOf(stored) > expiryOf(blob) && expiryOf(stored) - Date.now() > EXPIRY_MARGIN_MS) return stored
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
    const latest = storedBlob(name)
    if (latest && expiryOf(latest) > next.expiresAt) return latest
    vault.saveSecret('claude-code', name, out)
    return out
  })
}
