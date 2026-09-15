import type { ServiceId, UsageWindow } from '../shared/types'

export interface Captured {
  accountId: string
  email?: string
  /** Absent for a profile that only owns a companion surface (e.g. an app session). */
  blob?: string
  /** A companion surface's session, merged into the profile's blob by the caller. */
  appSession?: unknown
  /** User-facing detail about what else was snapshotted alongside the credentials. */
  note?: string
}

/** Maps a suffix to an absolute path where the adapter may keep a profile-scoped side file. */
export type ExtraPath = (suffix: string) => string

export interface UsageResult {
  windows: UsageWindow[]
  note?: string
  /** Short supplemental fact. */
  extra?: string
  /** Banked limit resets the account can spend (Codex). */
  banked?: number
  plan?: import('../shared/types').PlanInfo
  /** Set when the adapter refreshed the profile's tokens; the caller persists it. */
  updatedBlob?: string
  /** On a 429, ms until the provider will accept calls again (from Retry-After). */
  retryAfterMs?: number
  /** The sign-in is dead and no refresh can revive it — the account must sign in again. */
  expired?: boolean
}

/** Parse a Retry-After header (delta-seconds or HTTP date) into ms from now. */
export function retryAfterMs(res: { headers: { get(name: string): string | null } }): number | undefined {
  const raw = res.headers.get('retry-after')
  if (!raw) return undefined
  const secs = Number(raw)
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000)
  const when = Date.parse(raw)
  return Number.isNaN(when) ? undefined : Math.max(0, when - Date.now())
}

export interface Adapter {
  id: ServiceId
  name: string
  /** Where this provider's subscription is managed and cancelled. */
  billingUrl?: string
  /** Whether Aliax can start a sign-in flow itself (vs. only saving an existing login). */
  supportsLogin: boolean
  /** The optional places a switch can propagate to, user-toggleable in settings. */
  targets: { id: string; label: string }[]
  detect(): boolean
  /** Identity of the currently logged-in account, without touching the Keychain. */
  liveAccountId(): Promise<string | null>
  /** Read the live credentials into a serializable blob. */
  capture(extra: ExtraPath): Promise<Captured>
  /**
   * Write a captured blob back as the live credentials. `blob` is null for a
   * profile that only owns a companion surface; the adapter applies what it can
   * and reports what stayed unchanged. `on` holds the enabled target ids from
   * settings. Returns user-facing notes.
   */
  activate(blob: string | null, extra: ExtraPath, on: Set<string>): Promise<string[]>
  /**
   * Capture this service's independent companion surface (e.g. the desktop app's
   * own web session) into the profile of the account THAT surface is signed into,
   * which may differ from the main credentials' account. Linking both surfaces to
   * profiles is what lets a switch move them in tandem.
   */
  captureCompanion?(extraFor: (email: string) => ExtraPath): Promise<Captured | null>
  /**
   * `force` is the user's manual Refresh: skip any internal caches too.
   * `mayRefresh` (default true) lets the adapter renew a stored token in place;
   * a standby app passes false so only the gateway owner ever rotates a grant.
   */
  usage(blob: string, isActive: boolean, force?: boolean, mayRefresh?: boolean): Promise<UsageResult>
  /**
   * Token-level identity of the live credentials, for tools whose account metadata file
   * can be clobbered by running sessions. Match against fingerprintOf(blob).
   */
  liveFingerprint?(): Promise<string | null>
  fingerprintOf?(blob: string): string | null
  /** Who a stored blob really belongs to, used to repair mislabeled profiles. */
  identify?(blob: string): Promise<{ accountId: string; email?: string } | null>
  /**
   * Orders two credential snapshots of the SAME account (higher = newer), so a
   * save can refuse to go backwards. Claude uses the token's own expiry. Leave
   * absent when the live copy must always win (Codex: the rotating refresh
   * token makes the newest generation the only valid one, invariant 18).
   */
  freshness?(blob: string): number | null
  /** Whether the live credentials sit past their own expiry. Local and cheap. */
  liveCredentialExpired?(): Promise<boolean>
  /**
   * The account signed into each place this service reaches, keyed by a short label.
   * A service can span independent logins (a CLI token and a desktop app's web session),
   * and the UI must show each rather than implying one account owns everything.
   */
  liveSurfaces?(): Promise<Record<string, string | null>>
}

export function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split('.')[1]
  if (!part) throw new Error('not a JWT')
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
}
