/**
 * The host app (Aliax, temp-code) hands the core everything it would otherwise
 * take from Electron: where to keep files, which fetch reaches the providers
 * (Cloudflare refuses Node's fetch on chatgpt.com, Electron's `net.fetch` gets
 * through), how to seal secrets, and what to do with events it observes.
 * Nothing in the core imports `electron`.
 */
import type { ServiceId } from './shared/types'

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export type SecretsMode =
  /** Electron's safeStorage, handed over as two functions. */
  | { mode: 'safeStorage'; encrypt: (plain: string) => Buffer; decrypt: (blob: Buffer) => string }
  /**
   * Chromium's OSCrypt scheme with a key derived from a named Keychain item —
   * the same bytes Aliax's safeStorage writes, so both apps read one vault.
   */
  | { mode: 'chromiumKey'; keychainItem: string }
  /**
   * No Keychain at all (a Linux agent box): a random password in a file with
   * mode 0600, default `<dataDir>/vault.key`, stands in for the Keychain item
   * and feeds the same derivation, so the blobs stay the same "v10" bytes.
   */
  | { mode: 'fileKey'; path?: string }

export interface UsageSample {
  service: ServiceId
  account: string
  label: string
  usedPercent: number
  resetsAt?: number
  periodMs?: number
}

/**
 * Where a vault write came from: `local` is this machine's own doing (a
 * refresh, a capture, a sign-in), `sync` a copy another environment sent or
 * a rewrite made because of one. A host that syncs accounts forwards only
 * `local` saves, so a push never echoes back to its sender.
 */
export type SaveOrigin = 'local' | 'sync'

export interface Hooks {
  onUsageSample?: (sample: UsageSample) => void
  onAppEvent?: (kind: string, service?: ServiceId, account?: string, detail?: string) => void
  /** The pinned account changed (a switch, later a failover); hosts redraw. Not fired for cache writes: a host that answers it with a poll would loop. */
  onAccountsChanged?: () => void
  /** A secret landed in the vault (see SaveOrigin). Fired for every save, so hosts debounce. */
  onSecretSaved?: (serviceId: ServiceId, name: string, origin: SaveOrigin) => void
  /**
   * A copy this environment does not own is near the end of its access
   * token: ask `owner` (an environment id) for a fresh one. The host fetches
   * the owner's access-only copy, applies it (sync.ts applyTransfer) and
   * answers with the blob now in the vault, or null when the owner is
   * unreachable. Never called for an account this environment owns.
   */
  askOwner?: (serviceId: ServiceId, name: string, owner: string) => Promise<string | null>
}

/** `owner` runs the gateway and refreshes stored tokens; `standby` only reads. */
export type Role = 'owner' | 'standby'

export interface CoreConfig {
  dataDir: string
  fetch: Fetch
  secrets: SecretsMode
  /**
   * The Electron app name, used only in safeStorage mode to recover blobs
   * written under a previous name. Ignored in chromiumKey mode.
   */
  appName?: string
  hooks?: Hooks
  role?: () => Role
  /**
   * This host's identity among the environments that share accounts
   * (temp-code's `env_…` id). A profile's `owner` is compared to it: equal
   * means this host refreshes the grant, anything else means this host holds
   * an access-only copy. Absent (Aliax), every profile with an owner on file
   * belongs to someone else.
   */
  environmentId?: string
}

let current: CoreConfig | null = null

export function configure(config: CoreConfig): void {
  current = config
}

export function config(): CoreConfig {
  if (!current) throw new Error('aliax-core: configure() must run before use')
  return current
}

export const dataDir = (): string => config().dataDir
export const fetch: Fetch = (input, init) => config().fetch(input, init)
export const hooks = (): Hooks => config().hooks ?? {}
export const role = (): Role => config().role?.() ?? 'owner'
export const environmentId = (): string | null => config().environmentId ?? null
