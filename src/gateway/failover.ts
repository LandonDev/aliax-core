/**
 * Choosing the next account when the pinned one is out of a window.
 *
 * Pure functions over the usage reports the cache already holds, plus one
 * injected forced poll so a candidate is checked right before it is picked.
 * The host supplies the models its live threads use, so the pick has room in
 * every tier those threads will spend, not only the request that hit the wall.
 */
import type { ProfileView, ServiceId, UsageReport } from '../shared/types'
import type { Limit, LimitWindow } from './limits'

/** The URL segment the gateway routes on → the vault's service id. */
export const serviceIdOf = (service: string): ServiceId | null =>
  service === 'claude' ? 'claude-code' : service === 'codex' ? 'codex' : null

/**
 * Model families that carry their own weekly cap in Claude's `limits` array.
 * Extend when a new scoped cap shows up there; an absent cap counts as room.
 */
const SCOPED_CAPS: [RegExp, string][] = [[/fable/i, 'Fable']]

/** The window labels a model spends, in the report's own vocabulary. */
export function tiersFor(serviceId: ServiceId, model: string | null | undefined): string[] {
  if (serviceId === 'codex') return ['5h', 'week']
  const tiers = ['5h', 'Weekly']
  if (serviceId === 'claude-code' && model) {
    for (const [re, label] of SCOPED_CAPS) if (re.test(model)) tiers.push(label)
  }
  return tiers
}

/** Tiers of the request's model plus those of every model the host has live. */
export function requiredTiers(serviceId: ServiceId, model: string | null | undefined, liveModels: string[]): string[] {
  const out: string[] = []
  for (const m of [model, ...liveModels]) for (const t of tiersFor(serviceId, m)) if (!out.includes(t)) out.push(t)
  return out
}

/** The service's overall weekly window: the clock an unscoped failover pick is ordered by. */
export const weeklyLabel = (serviceId: ServiceId): string => (serviceId === 'codex' ? 'week' : 'Weekly')

/**
 * The window a per-thread pick is ordered by: the model's own weekly cap when
 * it has one (Fable), else the service's weekly window.
 */
export function orderLabel(serviceId: ServiceId, model: string | null | undefined): string {
  if (serviceId === 'claude-code' && model) {
    for (const [re, label] of SCOPED_CAPS) if (re.test(model)) return label
  }
  return weeklyLabel(serviceId)
}

/**
 * The scoped windows a model does not spend (Fable's, for Opus): an account
 * with those spent is worth nothing to the models that need them, so such a
 * model spends it first and leaves the fresh ones alone. Empty when the model
 * has a scoped cap of its own, is unknown, or the service has none.
 */
export function spendFirstLabels(serviceId: ServiceId, model: string | null | undefined): string[] {
  if (serviceId !== 'claude-code' || !model) return []
  if (SCOPED_CAPS.some(([re]) => re.test(model))) return []
  return SCOPED_CAPS.map(([, label]) => label)
}

/**
 * Whether the account's spend-first windows are all spent (full and not yet
 * lifted): the class a host watches to move a thread off an account whose
 * Fable window came back. Null when the model has no spend-first windows.
 */
export function scopedSpent(serviceId: ServiceId, model: string | null | undefined, report: UsageReport | undefined, now: number): boolean | null {
  const labels = spendFirstLabels(serviceId, model)
  if (!labels.length) return null
  return labels.every((label) => (liveWindow(report, label, now)?.usedPercent ?? 0) >= 100)
}

/**
 * A report's window unless it has lifted (its reset is past): a lifted
 * window's numbers are stale until the next poll, so it counts as absent —
 * unknown reset, full room.
 */
export function liveWindow(report: UsageReport | undefined, label: string, now: number): UsageReport['windows'][number] | undefined {
  const w = report?.windows.find((x) => x.label === label)
  return w && !(w.resetsAt !== undefined && w.resetsAt <= now) ? w : undefined
}

/** The limit a report's label stands for, so a cached full window can be reported like a 429. */
export function windowOfLabel(serviceId: ServiceId, label: string): LimitWindow {
  if (label === '5h') return '5h'
  if (label === weeklyLabel(serviceId)) return 'weekly'
  if (label === CREDITS) return 'credits'
  return { model: label }
}

/** The report label a classified limit lands on. */
export function limitLabel(serviceId: ServiceId, window: LimitWindow): string | null {
  if (window === 'transient') return null
  if (window === '5h') return '5h'
  if (window === 'weekly') return serviceId === 'codex' ? 'week' : 'Weekly'
  if (window === 'credits') return 'Credits'
  return window.model
}

const CREDITS = 'Credits'

/**
 * The first required window (or credits) that is full and has not reset, as
 * the limit a 429 on it would classify to; null when the account has room.
 */
export function blockedWindow(report: UsageReport | undefined, tiers: string[], now: number): Limit | null {
  if (!report) return null
  const serviceId: ServiceId = tiers.includes('week') ? 'codex' : 'claude-code'
  if (report.expired) return { window: 'credits' }
  for (const label of [...tiers, CREDITS]) {
    const w = report.windows.find((x) => x.label === label)
    if (!w) continue
    const lifted = w.resetsAt !== undefined && w.resetsAt <= now
    if (w.usedPercent >= 100 && !lifted) return { window: windowOfLabel(serviceId, label), resetsAt: w.resetsAt }
  }
  return null
}

/** Room means every required window (and credits) is under 100 % or has already reset. */
export const hasRoom = (report: UsageReport | undefined, tiers: string[], now: number): boolean =>
  blockedWindow(report, tiers, now) === null

/**
 * Soonest-to-reset first in the given window; an account with no such window
 * on file orders by its weekly reset instead (a plan without that cap), then
 * ones with no reset at all, and ones with no windows at all whose usage
 * endpoint is itself limited after those (their numbers are unknown). A
 * usage-poll throttle on an account with windows on file does not move it:
 * that 429 is the usage endpoint, not the model API, and the cached windows
 * still say how much room it has. Ties go to the account that has used more
 * of the window, so the one about to refill anyway gets spent first. A lifted
 * window (reset in the past) counts as absent, not soonest. `spendFirst`
 * windows lead the order: the account with the least room left in them first
 * (a full one ahead of a fresh one; no such window is full room).
 */
export function orderByReset(label: string | null, reports: UsageReport[], now: number, weekly: string | null = null, spendFirst: string[] = []) {
  const key = (name: string): number[] => {
    const r = reports.find((x) => x.profileName === name)
    const marked = r?.rateLimit?.until !== undefined && r.rateLimit.until > now
    const limited = marked && r.windows.length === 0 ? 1 : 0
    const w = (label && liveWindow(r, label, now)) || (weekly && liveWindow(r, weekly, now)) || undefined
    const spent = spendFirst.reduce((sum, l) => sum + (liveWindow(r, l, now)?.usedPercent ?? 0), 0)
    return [limited, -spent, w?.resetsAt ?? 1e14, -(w?.usedPercent ?? 0)]
  }
  return (a: string, b: string): number => {
    const ka = key(a)
    const kb = key(b)
    for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i]
    return 0
  }
}

export interface CandidateInput {
  serviceId: ServiceId
  profiles: Pick<ProfileView, 'name'>[]
  reports: UsageReport[]
  required: string[]
  tried: string[]
  now: number
  /** The window to order by; the service's weekly one when absent. */
  orderBy?: string
  /** Windows to spend down first: the least room left in them leads the order. */
  spendFirst?: string[]
}

/** Untried, unexpired accounts with room in every required tier, soonest reset first. */
export function candidates({ serviceId, profiles, reports, required, tried, now, orderBy, spendFirst }: CandidateInput): string[] {
  const weekly = weeklyLabel(serviceId)
  return profiles
    .map((p) => p.name)
    .filter((name) => !tried.includes(name))
    .filter((name) => hasRoom(reports.find((r) => r.profileName === name), required, now))
    .sort(orderByReset(orderBy ?? weekly, reports, now, weekly, spendFirst))
}

export interface PickInput {
  serviceId: ServiceId
  model: string | null | undefined
  /**
   * Models other live threads use. An unscoped pick (the pin, which every
   * unscoped request follows) needs room in all of their tiers; a scoped pick
   * serves one thread and ignores them.
   */
  liveModels?: string[]
  /** A per-thread pick: room in the model's own tiers, ordered by its window. */
  scoped?: boolean
  window: LimitWindow
  profiles: Pick<ProfileView, 'name'>[]
  reports: UsageReport[]
  tried: string[]
  /** Forced poll of one account; null when nothing fresh could be learned. */
  poll: (name: string) => Promise<UsageReport | null>
  now?: number
}

const plan = (input: Omit<PickInput, 'poll' | 'window'>): { required: string[]; orderBy: string; spendFirst: string[] } =>
  input.scoped
    ? {
        required: tiersFor(input.serviceId, input.model),
        orderBy: orderLabel(input.serviceId, input.model),
        spendFirst: spendFirstLabels(input.serviceId, input.model)
      }
    : { required: requiredTiers(input.serviceId, input.model, input.liveModels ?? []), orderBy: weeklyLabel(input.serviceId), spendFirst: [] }

/**
 * The next account to route to, after a forced poll confirms it still has
 * room. A poll that learns nothing does not block the pick: traffic, not
 * `/usage`, decides whether a switch landed.
 */
export async function pickNext(input: PickInput): Promise<string | null> {
  const now = input.now ?? Date.now()
  const { required, orderBy, spendFirst } = plan(input)
  for (const name of candidates({ ...input, required, orderBy, spendFirst, now })) {
    const fresh = await input.poll(name).catch(() => null)
    if (!fresh || hasRoom(fresh, required, now)) return name
  }
  return null
}

/**
 * The same pick from the cache alone, for a host choosing an account at spawn
 * time: many threads may start at once and must not each force a poll.
 */
export function pickFromCache(input: Omit<PickInput, 'poll' | 'window'>): string | null {
  const now = input.now ?? Date.now()
  const { required, orderBy, spendFirst } = plan(input)
  return candidates({ ...input, required, orderBy, spendFirst, now })[0] ?? null
}
