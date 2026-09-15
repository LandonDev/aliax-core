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

export interface UsageSample {
  service: ServiceId
  account: string
  label: string
  usedPercent: number
  resetsAt?: number
  periodMs?: number
}

export interface Hooks {
  onUsageSample?: (sample: UsageSample) => void
  onAppEvent?: (kind: string, service?: ServiceId, account?: string, detail?: string) => void
  /** The pinned account changed (a switch, later a failover); hosts redraw. Not fired for cache writes: a host that answers it with a poll would loop. */
  onAccountsChanged?: () => void
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
