/**
 * Choosing the next account when the pinned one is out of a window.
 *
 * Pure functions over the usage reports the cache already holds, plus one
 * injected forced poll so a candidate is checked right before it is picked.
 * The host supplies the models its live threads use, so the pick has room in
 * every tier those threads will spend, not only the request that hit the wall.
 */
import type { ProfileView, ServiceId, UsageReport } from '../shared/types'
import type { LimitWindow } from './limits'

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

/** The service's overall weekly window: the clock every failover pick is ordered by. */
export const weeklyLabel = (serviceId: ServiceId): string => (serviceId === 'codex' ? 'week' : 'Weekly')

/** The report label a classified limit lands on. */
export function limitLabel(serviceId: ServiceId, window: LimitWindow): string | null {
  if (window === 'transient') return null
  if (window === '5h') return '5h'
  if (window === 'weekly') return serviceId === 'codex' ? 'week' : 'Weekly'
  if (window === 'credits') return 'Credits'
  return window.model
}

const CREDITS = 'Credits'

/** Room means every required window (and credits) is under 100 % or has already reset. */
export function hasRoom(report: UsageReport | undefined, tiers: string[], now: number): boolean {
  if (!report) return true
  if (report.expired) return false
  for (const label of [...tiers, CREDITS]) {
    const w = report.windows.find((x) => x.label === label)
    if (!w) continue
    const lifted = w.resetsAt !== undefined && w.resetsAt <= now
    if (w.usedPercent >= 100 && !lifted) return false
  }
  return true
}

/**
 * Soonest-to-reset first in the given window — always the weekly one, whatever
 * window just closed, since the week is the budget that actually runs out;
 * accounts with no reset on file go last, and ones whose usage endpoint is
 * itself limited after those.
 */
export function orderByReset(label: string | null, reports: UsageReport[], now: number) {
  const key = (name: string): number => {
    const r = reports.find((x) => x.profileName === name)
    const limited = r?.rateLimit?.until !== undefined && r.rateLimit.until > now ? 1e15 : 0
    const reset = label ? r?.windows.find((w) => w.label === label)?.resetsAt : undefined
    return limited + (reset ?? 1e14)
  }
  return (a: string, b: string): number => key(a) - key(b)
}

export interface CandidateInput {
  serviceId: ServiceId
  profiles: Pick<ProfileView, 'name'>[]
  reports: UsageReport[]
  required: string[]
  tried: string[]
  now: number
}

/** Untried, unexpired accounts with room in every required tier, soonest weekly reset first. */
export function candidates({ serviceId, profiles, reports, required, tried, now }: CandidateInput): string[] {
  return profiles
    .map((p) => p.name)
    .filter((name) => !tried.includes(name))
    .filter((name) => hasRoom(reports.find((r) => r.profileName === name), required, now))
    .sort(orderByReset(weeklyLabel(serviceId), reports, now))
}

export interface PickInput {
  serviceId: ServiceId
  model: string | null | undefined
  liveModels: string[]
  window: LimitWindow
  profiles: Pick<ProfileView, 'name'>[]
  reports: UsageReport[]
  tried: string[]
  /** Forced poll of one account; null when nothing fresh could be learned. */
  poll: (name: string) => Promise<UsageReport | null>
  now?: number
}

/**
 * The next account to pin, after a forced poll confirms it still has room.
 * A poll that learns nothing does not block the pick: traffic, not `/usage`,
 * decides whether a switch landed.
 */
export async function pickNext(input: PickInput): Promise<string | null> {
  const now = input.now ?? Date.now()
  const required = requiredTiers(input.serviceId, input.model, input.liveModels)
  for (const name of candidates({ ...input, required, now })) {
    const fresh = await input.poll(name).catch(() => null)
    if (!fresh || hasRoom(fresh, required, now)) return name
  }
  return null
}
