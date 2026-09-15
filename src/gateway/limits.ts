/**
 * Rate-limit facts the gateway can read off traffic it forwards, so the
 * pinned account's windows move with every turn instead of waiting for a poll.
 *
 * Claude sends `anthropic-ratelimit-unified-*` headers on every response:
 * utilization is a 0..1 fraction (it can pass 1), resets are epoch seconds.
 * Codex has no such headers; its windows arrive as an app-server snapshot.
 */
import type { UsageWindow } from '../shared/types'
import { windowLabel } from '../adapters/codex'

export interface HeaderLike {
  get(name: string): string | null
}

export type UnifiedStatus = 'allowed' | 'allowed_warning' | 'rejected'

export interface UnifiedLimits {
  status: UnifiedStatus | null
  /** When the limiting window lifts, epoch ms. */
  resetsAt?: number
  /** Which window is limiting: `five_hour`, `seven_day`, `overage`, … */
  representativeClaim?: string
  /** The rolling 5h and Weekly windows, as `usage()` would label them. */
  windows: UsageWindow[]
  overage?: { status?: string; usedPercent?: number; resetsAt?: number }
}

const PREFIX = 'anthropic-ratelimit-unified'
const ROLLING: [key: string, label: string, periodMs: number][] = [
  ['5h', '5h', 5 * 3_600_000],
  ['7d', 'Weekly', 7 * 86_400_000]
]

const num = (v: string | null): number | undefined => {
  if (v === null || v.trim() === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}
const epochMs = (v: string | null): number | undefined => {
  const n = num(v)
  return n === undefined ? undefined : n * 1000
}
const percent = (fraction: number): number => Math.round(fraction * 1000) / 10
const isStatus = (v: string | null): v is UnifiedStatus =>
  v === 'allowed' || v === 'allowed_warning' || v === 'rejected'

/** Null when the response carries no unified headers at all. */
export function parseUnifiedHeaders(headers: HeaderLike): UnifiedLimits | null {
  const get = (suffix: string): string | null => headers.get(`${PREFIX}-${suffix}`)
  const status = get('status')
  const windows: UsageWindow[] = []
  for (const [key, label, periodMs] of ROLLING) {
    const utilization = num(get(`${key}-utilization`))
    if (utilization === undefined) continue
    windows.push({ label, usedPercent: percent(utilization), periodMs, resetsAt: epochMs(get(`${key}-reset`)) })
  }
  const overageStatus = get('overage-status')
  const overageUtilization = num(get('overage-utilization'))
  if (status === null && windows.length === 0 && overageStatus === null && overageUtilization === undefined) return null
  const out: UnifiedLimits = { status: isStatus(status) ? status : null, windows }
  const resetsAt = epochMs(get('reset'))
  if (resetsAt !== undefined) out.resetsAt = resetsAt
  const claim = get('representative-claim')
  if (claim) out.representativeClaim = claim
  if (overageStatus !== null || overageUtilization !== undefined) {
    out.overage = {
      status: overageStatus ?? undefined,
      usedPercent: overageUtilization === undefined ? undefined : percent(overageUtilization),
      resetsAt: epochMs(get('overage-reset'))
    }
  }
  return out
}

/** The app-server's `account/rateLimits/updated` payload, either key style. */
interface SnapshotWindow {
  usedPercent?: number
  used_percent?: number
  windowDurationMins?: number | null
  window_minutes?: number | null
  resetsAt?: number | null
  resets_at?: number | null
}
interface Snapshot {
  rateLimits?: Snapshot
  primary?: SnapshotWindow | null
  secondary?: SnapshotWindow | null
}

/**
 * Codex windows from an app-server snapshot, labelled the way the usage poll
 * labels them so the two sources merge into the same rows.
 */
export function codexSnapshotToWindows(snapshot: unknown): UsageWindow[] {
  if (!snapshot || typeof snapshot !== 'object') return []
  const s = snapshot as Snapshot
  const inner = s.rateLimits ?? s
  const windows: UsageWindow[] = []
  for (const w of [inner.primary, inner.secondary]) {
    const used = w?.usedPercent ?? w?.used_percent
    if (!w || typeof used !== 'number') continue
    const minutes = w.windowDurationMins ?? w.window_minutes ?? undefined
    const reset = w.resetsAt ?? w.resets_at ?? undefined
    windows.push({
      label: windowLabel(minutes),
      usedPercent: used,
      periodMs: minutes ? minutes * 60_000 : undefined,
      // The app-server reports seconds; a millisecond value would already be huge.
      resetsAt: typeof reset === 'number' ? (reset < 1e12 ? reset * 1000 : reset) : undefined
    })
  }
  return windows
}

/** Which bucket a 429 charged. `transient` means "the CLI retries this itself". */
export type LimitWindow = '5h' | 'weekly' | 'credits' | 'transient' | { model: string }

export interface Limit {
  window: LimitWindow
  /** When the bucket lifts, epoch ms. */
  resetsAt?: number
  /** The raw `representative-claim` (Claude) or `rate_limit_reached_type` (Codex), for the log. */
  claim?: string
}

/**
 * `anthropic-ratelimit-unified-representative-claim` → window. Seeded from
 * the CLI's own window names; a claim the live capture shows that is missing
 * here falls back to its prefix, then to the body text.
 */
export const CLAIM_WINDOWS: Record<string, LimitWindow> = {
  five_hour: '5h',
  seven_day: 'weekly',
  seven_day_opus: { model: 'Opus' },
  seven_day_sonnet: { model: 'Sonnet' },
  seven_day_fable: { model: 'Fable' },
  seven_day_cowork: { model: 'Cowork' },
  overage: 'credits'
}

const CLAUDE_TEXT: [RegExp, (m: RegExpMatchArray) => LimitWindow][] = [
  [/session limit/i, () => '5h'],
  [/weekly limit/i, () => 'weekly'],
  [/reached your (\w+) limit/i, (m) => ({ model: m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() })],
  [/usage credits|spend limit|out of credits|shared budget|extra usage/i, () => 'credits']
]

function classifyClaude(headers: HeaderLike, body: string): Limit {
  const unified = parseUnifiedHeaders(headers)
  // No unified headers: an edge or overload answer, which the CLI retries itself.
  if (!unified) return { window: 'transient' }
  const claim = unified.representativeClaim
  const base: Limit = { resetsAt: unified.resetsAt, claim, window: 'transient' }
  if (unified.status === 'rejected' && claim) {
    const known = CLAIM_WINDOWS[claim]
    if (known) return { ...base, window: known }
    if (claim.startsWith('seven_day')) return { ...base, window: 'weekly' }
    if (claim.startsWith('five_hour')) return { ...base, window: '5h' }
  }
  for (const [re, window] of CLAUDE_TEXT) {
    const m = body.match(re)
    if (m) return { ...base, window: window(m) }
  }
  // Rejected for a reason we cannot name: still a real limit, charge the 5h window.
  if (unified.status === 'rejected') return { ...base, window: '5h' }
  return base
}

interface CodexError {
  type?: string
  code?: string
  message?: string
  rate_limit_reached_type?: string
  resets_at?: number
  resets_in_seconds?: number
}

function classifyCodex(body: string): Limit {
  let error: CodexError = {}
  try {
    const parsed = JSON.parse(body)
    error = (parsed?.error ?? parsed ?? {}) as CodexError
  } catch {
    error = { message: body }
  }
  const kind = error.type ?? error.code ?? ''
  const code = error.code ?? error.type ?? ''
  const message = error.message ?? ''
  const resetsAt =
    typeof error.resets_at === 'number'
      ? error.resets_at < 1e12
        ? error.resets_at * 1000
        : error.resets_at
      : typeof error.resets_in_seconds === 'number'
        ? Date.now() + error.resets_in_seconds * 1000
        : undefined
  if (kind === 'usage_limit_reached' || code === 'usage_limit_reached') {
    const which = error.rate_limit_reached_type
    const window: LimitWindow = which === 'secondary' || (!which && /week/i.test(message)) ? 'weekly' : '5h'
    return { window, resetsAt, claim: which }
  }
  if (/quota_exceeded|usage_not_included|insufficient_quota|credits/i.test(`${kind} ${code} ${message}`)) {
    return { window: 'credits', resetsAt }
  }
  return { window: 'transient', resetsAt }
}

/** What a 429 from the provider means for the account that sent the request. */
export function classify429(service: string, headers: HeaderLike, body: string): Limit {
  if (service === 'claude') return classifyClaude(headers, body)
  if (service === 'codex') return classifyCodex(body)
  return { window: 'transient' }
}
