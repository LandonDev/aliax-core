export type ServiceId = 'claude-code' | 'codex' | 'cursor'

export interface ProfileView {
  name: string
  email?: string
  nickname?: string
  color?: string
  createdAt: number
  lastActivatedAt?: number
  /** True when this account is the one the CLI uses. */
  active: boolean
  /** Surfaces this account is currently signed into, e.g. ["CLI", "App"]. */
  activeOn?: string[]
  /** Another saved profile holds credentials for this same account. */
  duplicate?: boolean
}

export interface SwitchTarget {
  id: string
  label: string
}

export type WindowMode = 'normal' | 'mini'

export interface Settings {
  windowMode: WindowMode
  /** serviceId -> targetId -> enabled. Missing entries mean enabled. */
  switchTargets: Partial<Record<ServiceId, Record<string, boolean>>>
  /** Route CLI traffic through Aliax so switching never kills a session. */
  proxyEnabled?: boolean
  /** serviceId -> profile name the proxy should authenticate as. */
  proxyAccounts?: Partial<Record<ServiceId, string>>
  /** Open Aliax automatically when you log in. */
  launchAtLogin?: boolean
  /** Set once the first-run "open at login" prompt has been answered either way. */
  askedLaunchAtLogin?: boolean
}

/** Where the in-app updater is in its idle → available → downloading → ready life. */
export interface UpdateStatus {
  state: 'idle' | 'available' | 'downloading' | 'ready' | 'error'
  version?: string
  percent?: number
  error?: string
}

export interface ProxyStatus {
  running: boolean
  port: number
  claudeBaseUrl: string | null
  codexBaseUrl: string | null
  /** Requests forwarded per service since start — proof it is really in use. */
  routed: Record<string, number>
  /** Profile name each service is authenticating as right now. */
  accounts: Partial<Record<ServiceId, string | null>>
  error: string | null
}

export interface ShimStatus {
  installed: boolean
  running: boolean
  port: number
}

export interface ShellIntegration {
  installed: boolean
  rcPath: string
  snippetPath: string
  supported: boolean
}

/** A running CLI session and whether its traffic already flows through Aliax. */
export interface LiveSession {
  serviceId: ServiceId
  pid: number
  cwd: string | null
  tty: string | null
  proxied: boolean
}

export interface ServiceView {
  id: ServiceId
  name: string
  installed: boolean
  canAddAccount: boolean
  /** True when a live login exists that Aliax has not saved yet. */
  canSaveCurrent: boolean
  /** Where this provider's subscription is managed and cancelled. */
  billingUrl?: string
  switchTargets: SwitchTarget[]
  profiles: ProfileView[]
  /** Something true about the service that no saved account explains. */
  notice?: string
}

export interface UsageWindow {
  label: string
  usedPercent: number
  resetsAt?: number
  /** Length of the refill cycle, so the UI never has to infer it from the label. */
  periodMs?: number
}

/** What this account costs and when it bills again. */
export interface PlanInfo {
  /** Human name, e.g. "Max 20x". */
  name: string
  /** Monthly price in whole dollars, when we can identify the tier. */
  monthlyUsd?: number
  /** Next billing date, derived from the subscription's anchor day. */
  renewsAt?: number
  /** Day of month the subscription bills on. */
  anchorDay?: number
  /** Cancellation is pending: access ends here instead of renewing. */
  cancelsAt?: number
  status?: string
}

export interface UsageReport {
  profileName: string
  windows: UsageWindow[]
  note?: string
  /** Short supplemental fact. */
  extra?: string
  /** Banked limit resets the account can spend (Codex). */
  banked?: number
  plan?: PlanInfo
  /**
   * Set while the provider is refusing calls. The windows shown are the last
   * good ones; `until` is when the limit lifts, if the provider told us.
   */
  rateLimit?: { provider: string; until?: number }
  /** The sign-in has expired; the row offers a one-click same-email re-login. */
  expired?: boolean
}

export type ActionResult = { ok: true; name?: string; notes?: string[] } | { ok: false; error: string }
