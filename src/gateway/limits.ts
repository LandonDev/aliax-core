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
