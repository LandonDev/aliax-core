import { createHash } from 'node:crypto'
import type { Adapter, Captured, UsageResult } from './types'

/**
 * temp-code's add-on grants: the values an MCP add-on's `env` or `headers`
 * name, and its OAuth sign-in. One profile per add-on (profile name and
 * account are the add-on's id, nickname its name). The host app writes them
 * (saveAddonGrant) and reads them; no CLI ever holds one, so there is no
 * live credential, no capture and no switch, and no account page lists the
 * service (`internal`). A grant without an `oauth` section is static and
 * ownerless, held by every host; an OAuth grant has an owner, the one host
 * that presents its refresh token (refreshAddon). This mirrors temp-code's
 * `AddonGrantBlobSchema` (src/shared/addonGrant.ts) field for field.
 */
export const ADDON_SERVICE = 'addon'

export interface AddonGrantOAuth {
  clientId: string
  clientSecret?: string
  redirectPort: number
  authorizationUrl: string
  tokenUrl: string
  scope?: string
  resource?: string
  issuer?: string
  accessToken?: string
  refreshToken?: string
  expiresAt?: number
}

export interface AddonGrant {
  v: 1
  mintedBy: 'app'
  addonId: string
  fields: Record<string, string>
  oauth?: AddonGrantOAuth
}

const isRecordOfStrings = (v: unknown): v is Record<string, string> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string')

/** The grant in a stored blob, null for anything else. Checks v, mintedBy, addonId, fields and the oauth section's required keys; never throws. */
export function addonGrantOf(blob: string): AddonGrant | null {
  let v: unknown
  try {
    v = JSON.parse(blob)
  } catch {
    return null
  }
  if (!v || typeof v !== 'object') return null
  const g = v as Record<string, unknown>
  if (g.v !== 1 || g.mintedBy !== 'app' || typeof g.addonId !== 'string' || !isRecordOfStrings(g.fields)) return null
  if (g.oauth !== undefined) {
    const o = g.oauth as Record<string, unknown> | null
    if (!o || typeof o !== 'object') return null
    if (typeof o.clientId !== 'string' || typeof o.redirectPort !== 'number' || typeof o.authorizationUrl !== 'string' || typeof o.tokenUrl !== 'string') return null
  }
  return g as unknown as AddonGrant
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')

export const addon: Adapter = {
  id: 'addon',
  name: 'Add-on grants',
  supportsLogin: false,
  targets: [],
  internal: true,

  detect: () => true,

  async liveAccountId() {
    return null
  },

  async capture(): Promise<Captured> {
    throw new Error('add-on grants are saved by the app')
  },

  async activate(): Promise<string[]> {
    return []
  },

  async identify(blob: string) {
    const g = addonGrantOf(blob)
    return g ? { accountId: g.addonId } : null
  },

  async usage(blob: string): Promise<UsageResult> {
    const g = addonGrantOf(blob)
    if (!g) return { windows: [], settled: true, note: 'not a grant' }
    if (!g.oauth) return { windows: [], settled: true, note: 'values saved' }
    if (!g.oauth.accessToken) return { windows: [], settled: true, note: 'not signed in' }
    const lapsed = typeof g.oauth.expiresAt === 'number' && g.oauth.expiresAt <= Date.now() && !g.oauth.refreshToken
    return lapsed ? { windows: [], settled: true, note: 'signed in', expired: true } : { windows: [], settled: true, note: 'signed in' }
  },

  fingerprintOf(blob: string) {
    const g = addonGrantOf(blob)
    if (!g) return null
    return g.oauth?.refreshToken ? `app:${sha256(g.oauth.refreshToken)}` : `app:${g.addonId}`
  },

  async liveFingerprint() {
    return null
  }
}
