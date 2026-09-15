import { existsSync, readFileSync, statSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ActionResult, ServiceId, ServiceView, UsageReport, UsageWindow } from './shared/types'
import { adapter, adapters } from './adapters'
import type { Adapter, Captured } from './adapters/types'
import { pinProfile } from './settings'
import { dataDir, fetch, hooks, role } from './config'
import { isLive, readMarker } from './gateway/marker'
import { writeAtomic } from './fs'
import { enabledTargets } from './settings'
import * as vault from './vault'

export const extra =
  (serviceId: ServiceId, name: string) =>
  (suffix: string): string =>
    vault.extraPath(serviceId, name, suffix)

/**
 * OpenAI rotates the Codex refresh token in place: every refresh invalidates
 * the previous one, and presenting a superseded token revokes the whole grant.
 * Watching auth.json pulls each new generation into the vault the moment the
 * CLI writes it, so a saved copy never falls behind and trips that detection.
 */
export function watchLiveCredentials(): void {
  const dir = join(homedir(), '.codex')
  if (!existsSync(dir)) return
  let timer: NodeJS.Timeout | null = null
  watch(dir, (_event, filename) => {
    if (filename !== 'auth.json') return
    if (timer) clearTimeout(timer)
    // Debounced: switches and logins rewrite the file several times in a burst.
    timer = setTimeout(() => {
      recaptureLive(adapter('codex')).catch(() => {})
    }, 1500)
  })
}

/**
 * Which stored profile is live right now, by account identity. Fingerprints only
 * disambiguate when several profiles hold the same account, since refresh tokens
 * rotate and a stale one must never make the account you are using look inactive.
 */
async function activeProfileName(a: Adapter): Promise<string | null> {
  const liveId = await a.liveAccountId().catch(() => null)
  if (!liveId) return null
  const candidates = vault.profiles(a.id).filter((p) => p.accountId === liveId)
  if (candidates.length <= 1) return candidates[0]?.name ?? null

  if (a.liveFingerprint && a.fingerprintOf) {
    const fp = await a.liveFingerprint().catch(() => null)
    if (fp) {
      for (const p of candidates) {
        const blob = vault.readSecret(a.id, p.name)
        if (blob && a.fingerprintOf(blob) === fp) return p.name
      }
    }
  }
  return candidates[0].name
}

/**
 * A snapshot may be stale, but it must never go BACKWARDS: capturing a dead
 * live token over a freshly re-signed vault copy is how a re-add silently
 * undid itself. Adapters that can order two snapshots of the same account
 * (Claude, via the token's own expiry) declare `freshness`; without it the
 * live copy always wins — correct for Codex, whose rotating refresh token
 * makes the on-disk file the one rightful newest (invariant 18).
 */
function saveSecretUnlessOlder(a: Adapter, name: string, blob: string): boolean {
  if (a.freshness) {
    let prior: string | null = null
    try {
      prior = vault.readSecret(a.id, name)
    } catch {
      // undecryptable stored copy: the incoming one can only improve things
    }
    const priorAt = prior ? a.freshness(prior) : null
    const nextAt = a.freshness(blob)
    if (priorAt !== null && nextAt !== null && nextAt < priorAt) return false
  }
  vault.saveSecret(a.id, name, blob)
  return true
}

/**
 * Save the live credentials into the matching stored profile, so tokens the tool
 * refreshed since the last capture are not lost on switch. Skips when the live
 * account cannot be matched confidently — never risks writing one account's
 * credentials into another's profile.
 */
export async function recaptureLive(a: Adapter): Promise<void> {
  const name = await activeProfileName(a)
  const existing = vault.profiles(a.id).find((p) => p.name === name)
  if (existing) {
    const captured = await a.capture(extra(a.id, existing.name))
    if (captured.accountId === existing.accountId && captured.blob !== undefined) {
      saveSecretUnlessOlder(a, existing.name, captured.blob)
      vault.upsertProfile(a.id, { ...existing, email: captured.email ?? existing.email })
    }
  }
  // File the companion surface (e.g. the app session) under whoever owns it,
  // so switching away never loses a login that was signed in out-of-band.
  if (a.captureCompanion) {
    const companion = await a.captureCompanion((email) => extra(a.id, email)).catch(() => null)
    if (companion) saveCaptured(a.id, companion)
  }
}

/**
 * Store a captured credential set, merging into the existing profile for the same
 * account. Matches by account id, then by email — an app-only profile is keyed by
 * email until its CLI credentials arrive and upgrade the id.
 */
export function saveCaptured(serviceId: ServiceId, captured: Captured): string | null {
  const existing = vault.profiles(serviceId)
  const match =
    existing.find((p) => p.accountId === captured.accountId) ??
    (captured.email
      ? existing.find((p) => p.email?.toLowerCase() === captured.email?.toLowerCase())
      : undefined)

  // A companion surface (the Claude app's web session) rides along with an
  // account we already hold. On its own it can neither switch nor report usage,
  // so a standalone row for it is a dead end — skip it and let the section
  // notice say the app is signed into an account that is not saved here.
  if (captured.blob === undefined && !match) return null

  const name = match?.name ?? captured.email ?? `account-${existing.length + 1}`

  if (captured.blob !== undefined) {
    saveSecretUnlessOlder(adapter(serviceId), name, captured.blob)
  } else if (captured.appSession !== undefined) {
    // App-session-only save: merge into any existing credentials for this account
    // rather than replacing them, so a profile accumulates both halves.
    const prior = vault.readSecret(serviceId, name)
    const merged = prior ? { ...JSON.parse(prior), appSession: captured.appSession } : { appSession: captured.appSession }
    vault.saveSecret(serviceId, name, JSON.stringify(merged))
  }
  vault.upsertProfile(serviceId, {
    ...match,
    name,
    // A credential-derived uuid beats an email placeholder from an app-only save.
    accountId:
      captured.blob !== undefined ? captured.accountId : (match?.accountId ?? captured.accountId),
    hasAppSession: captured.appSession !== undefined ? true : match?.hasAppSession,
    email: captured.email ?? match?.email,
    createdAt: match?.createdAt ?? Date.now()
  })
  return name
}

/**
 * Capture every surface of a service, each filed under its own account: the main
 * credentials under theirs, the companion surface (e.g. desktop app session) under
 * whoever it is signed into. This linking is what makes switches move in tandem.
 */
async function captureAll(a: Adapter): Promise<ActionResult> {
  const notes: string[] = []
  let name: string | undefined
  let mainError: string | null = null

  try {
    const captured = await a.capture(extra(a.id, 'pending'))
    if (a.identify && captured.blob) {
      const truth = await a.identify(captured.blob).catch(() => null)
      if (truth) {
        captured.accountId = truth.accountId
        captured.email = truth.email ?? captured.email
      }
    }
    name = saveCaptured(a.id, captured) ?? undefined
    if (name) {
      vault.adoptExtras(a.id, 'pending', name)
      notes.push(`Saved ${name}`)
      if (captured.note) notes.push(captured.note)
    }
  } catch (e) {
    mainError = (e as Error).message
  }

  if (a.captureCompanion) {
    const companion = await a
      .captureCompanion((email) => extra(a.id, email))
      .catch(() => null)
    if (companion) {
      const companionName = saveCaptured(a.id, companion)
      if (companionName) notes.push(companion.note ?? `Saved ${companionName}`)
      else if (companion.email)
        notes.push(`Claude app uses ${companion.email}. Add that account to save it too`)
    }
  }

  if (notes.length === 0) return { ok: false, error: mainError ?? 'nothing to save' }
  if (mainError) notes.push(`CLI sign-in not saved (${mainError})`)
  clearUsageCache(a.id)
  return { ok: true, name, notes }
}

export function updateProfile(
  serviceId: ServiceId,
  name: string,
  patch: { nickname?: string; color?: string }
): ActionResult {
  const profile = vault.profiles(serviceId).find((p) => p.name === name)
  if (!profile) return { ok: false, error: 'unknown profile' }
  vault.upsertProfile(serviceId, {
    ...profile,
    nickname: patch.nickname?.trim() || undefined,
    color: patch.color || undefined
  })
  return { ok: true }
}

/**
 * Correct profile labels from what their stored credentials actually are. Profiles
 * saved before identity became token-derived can carry another account's name and id.
 */
export async function repairProfiles(serviceId: ServiceId): Promise<void> {
  const a = adapter(serviceId)
  if (!a.identify) return
  for (const p of vault.profiles(serviceId)) {
    const blob = vault.readSecret(serviceId, p.name)
    if (!blob) continue
    const truth = await a.identify(blob).catch(() => null)
    if (!truth) continue
    if (truth.accountId === p.accountId && (!truth.email || truth.email === p.email)) continue
    vault.upsertProfile(serviceId, {
      ...p,
      accountId: truth.accountId,
      email: truth.email ?? p.email
    })
  }
}

export async function listServices(): Promise<ServiceView[]> {
  return Promise.all(
    adapters.map(async (a) => {
      const installed = a.detect()
      const profiles = vault.profiles(a.id)
      const active = installed ? await activeProfileName(a) : null
      const counts = new Map<string, number>()
      for (const p of profiles) counts.set(p.accountId, (counts.get(p.accountId) ?? 0) + 1)

      const surfaces = installed ? await a.liveSurfaces?.().catch(() => null) : null
      const same = (a?: string | null, b?: string | null): boolean =>
        !!a && !!b && a.toLowerCase() === b.toLowerCase()

      // Name each surface signed into an account we have not saved. One list, no
      // sentence per surface: the panel header already says which service, and
      // repeating "which is not saved here" three times wrapped to two lines.
      const named = Object.entries(surfaces ?? {})
        .filter(([, who]) => who && !profiles.some((p) => same(p.email, who)))
        .map(([where, who]) => `${where} ${who}`)

      // Is the CLI itself on an account we have never saved? `active` is null
      // both when nothing is signed in and when the live account is unsaved, so
      // ask for the live id to tell those apart.
      const liveId = installed && active === null ? await a.liveAccountId().catch(() => null) : null
      const notice =
        named.length > 0
          ? `Not saved: ${named.join(', ')}`
          : liveId
            ? 'Signed in with an account you have not saved'
            : undefined

      return {
        id: a.id,
        name: a.name,
        installed,
        canAddAccount: a.supportsLogin,
        // Saving is only offered when there is genuinely something new to save.
        canSaveCurrent: notice !== undefined,
        billingUrl: a.billingUrl,
        switchTargets: a.targets,
        notice,
        profiles: profiles.map((p) => ({
          name: p.name,
          email: p.email,
          nickname: p.nickname,
          color: p.color,
          createdAt: p.createdAt,
          lastActivatedAt: p.lastActivatedAt,
          active: p.name === active,
          activeOn: surfaces
            ? Object.entries(surfaces)
                .filter(([, who]) => same(p.email, who))
                .map(([where]) => where)
            : p.name === active
              ? ['Active']
              : [],
          duplicate: (counts.get(p.accountId) ?? 0) > 1
        }))
      }
    })
  )
}

export async function capture(serviceId: ServiceId): Promise<ActionResult> {
  return captureAll(adapter(serviceId))
}

/** Returns an error message when the live credentials are not the ones we just installed. */
async function verifySwitch(
  a: Adapter,
  blob: string,
  profile: vault.StoredProfile
): Promise<string | null> {
  const expectedFp = a.fingerprintOf?.(blob)
  const liveFp = await a.liveFingerprint?.().catch(() => null)
  if (expectedFp && liveFp) {
    return expectedFp === liveFp
      ? null
      : 'the switch did not stick. Something rewrote the credentials. Quit running sessions and try again.'
  }
  const liveId = await a.liveAccountId().catch(() => null)
  if (liveId && liveId !== profile.accountId) {
    return `the switch did not stick. Still signed in as another account. Quit running sessions and try again.`
  }
  return null
}

export async function activate(serviceId: ServiceId, name: string): Promise<ActionResult> {
  const a = adapter(serviceId)
  const profile = vault.profiles(serviceId).find((p) => p.name === name)
  if (!profile) return { ok: false, error: 'unknown profile' }
  // null = companion-only profile; the adapter applies the surfaces it has.
  const blob = vault.readSecret(serviceId, name)

  try {
    await recaptureLive(a)
  } catch {
    // best effort; the switch itself matters more
  }
  const notes = await a.activate(blob, extra(serviceId, name), enabledTargets(serviceId, a.targets))

  // Prove the switch landed rather than trusting that activate() worked. Catches a
  // tool changing where it stores credentials, or a session writing the old ones back.
  // Companion-only profiles installed nothing verifiable, so there is nothing to check.
  if (blob !== null) {
    const failure = await verifySwitch(a, blob, profile)
    if (failure) return { ok: false, error: failure }
  }

  // Point the proxy at this account too. Pinning by profile rather than reading
  // the live credential means a CLI that writes its own refreshed tokens back to
  // disk cannot drag proxied sessions to the account we just left.
  // The adapters count the sessions that actually followed; an unconditional
  // note here claimed a switch even when nothing was running.
  pinProfile(serviceId, name)

  hooks().onAppEvent?.('switch', serviceId, name, notes.join(' · '))
  vault.upsertProfile(serviceId, { ...profile, lastActivatedAt: Date.now() })
  clearUsageCache(serviceId)
  return { ok: true, notes }
}

// Usage cache persists to disk so restarts keep showing last-known numbers.
// Claude's usage endpoint rate-limits hard, so it gets a much longer TTL.
const USAGE_TTL: Partial<Record<ServiceId, number>> = { 'claude-code': 10 * 60_000 }
const DEFAULT_TTL = 90_000
/** Bump when UsageReport gains a field, to retire reports that predate it. */
const CACHE_EPOCH = Date.parse('2026-08-02T00:00:00Z')
/** `stale` forces the next poll to go to the network while keeping the numbers. */
interface CacheEntry {
  at: number
  report: UsageReport
  stale?: boolean
}
let usageCache: Map<string, CacheEntry> | null = null
/** mtime of the file the in-memory copy was loaded from; the other app may have written since. */
let loadedMtime = 0

const usageCachePath = (): string => join(dataDir(), 'usage-cache.json')

function fileMtime(): number {
  try {
    return statSync(usageCachePath()).mtimeMs
  } catch {
    return 0
  }
}

/**
 * Two apps share one cache file: the gateway owner polls and writes, the
 * standby reads. Reload whenever the file's mtime moved past what we loaded,
 * so a standby never serves numbers the owner has already replaced.
 */
function cache(): Map<string, CacheEntry> {
  const mtime = fileMtime()
  if (usageCache && mtime === loadedMtime) return usageCache
  usageCache = new Map()
  loadedMtime = mtime
  try {
    const raw = JSON.parse(readFileSync(usageCachePath(), 'utf8'))
    for (const [k, v] of Object.entries(raw)) {
      const entry = v as CacheEntry
      // Reports cached before a field existed can never gain it while they sit
      // inside their TTL, so drop anything older than the newest shape.
      if (entry.at < CACHE_EPOCH) continue
      usageCache.set(k, entry)
    }
  } catch {
    // no cache yet
  }
  return usageCache
}

function persistCache(): void {
  writeAtomic(usageCachePath(), JSON.stringify(Object.fromEntries(cache())))
  loadedMtime = fileMtime()
  hooks().onAccountsChanged?.()
}


/**
 * Force the next poll onto the network without throwing the numbers away. A
 * switch or a save has to re-read usage, but deleting the entry left a
 * rate-limited account with nothing to fall back on — which is how a row that
 * had shown real percentages a second earlier came back as a bare dash.
 *
 * `freshlySigned` names a profile whose credentials a real sign-in just
 * replaced. Rate limits are bucketed per token, so a window recorded against
 * the old token means nothing to the new one — and the gate in usage() runs
 * before staleness, so leaving it would block the fresh token for the rest of
 * the countdown. That gate is why remove-and-re-add never recovered a row.
 */
/**
 * Whether the last poll flagged this profile's sign-in as dead. Read it BEFORE
 * clearUsageCache strips the flag: it is what tells a same-account re-sign-in
 * to repair the CLI when the token was revoked ahead of its recorded expiry,
 * where the local clock says nothing is wrong.
 */
export function reportedExpired(serviceId: ServiceId, name: string): boolean {
  return cache().get(`${serviceId}:${name}`)?.report.expired === true
}

export function clearUsageCache(serviceId: ServiceId, freshlySigned?: string): void {
  for (const [key, entry] of cache()) {
    if (!key.startsWith(`${serviceId}:`)) continue
    const fresh = freshlySigned !== undefined && key === `${serviceId}:${freshlySigned}`
    cache().set(key, {
      ...entry,
      stale: true,
      report: fresh ? { ...entry.report, rateLimit: undefined, expired: undefined } : entry.report
    })
  }
  persistCache()
}

/**
 * `force` bypasses the freshness cache to poll the APIs live — what the Refresh
 * button does. It never bypasses an active rate-limit window: a manual refresh
 * that hammered a 429 is exactly what once pinned an account for an hour.
 */
/** The mtime of the usage cache as last read or written here; other writers differ. */
export const cacheMtimeSeen = (): number => loadedMtime

/**
 * A standby must not poll: one poller per machine keeps the 429 budget whole
 * and the stored tokens in one refresher's hands. Its forced refresh goes to
 * the gateway owner's control endpoint, which polls and writes the shared
 * cache; the reply is the owner's fresh reports. Null when no owner answers.
 */
async function forwardedUsage(serviceId: ServiceId): Promise<UsageReport[] | null> {
  const owner = readMarker()
  if (!isLive(owner) || owner.pid === process.pid) return null
  try {
    const res = await fetch(`${owner.url}/__aliax/usage?service=${serviceId}&force=1`, {
      signal: AbortSignal.timeout(60_000)
    })
    if (!res.ok) return null
    const { reports } = (await res.json()) as { reports: UsageReport[] }
    cache()
    return reports
  } catch {
    return null
  }
}

export async function usage(serviceId: ServiceId, force = false): Promise<UsageReport[]> {
  if (force && role() === 'standby') {
    const forwarded = await forwardedUsage(serviceId)
    if (forwarded) return forwarded
  }
  const a = adapter(serviceId)
  const profiles = vault.profiles(serviceId)
  const active = await activeProfileName(a)
  const ttl = USAGE_TTL[serviceId] ?? DEFAULT_TTL
  const now = Date.now()
  // One account at a time. Every profile in a service hits the same host, and
  // firing them together earns a 429 that leaves later accounts with no usage
  // and no plan — which is exactly how three of four Claude rows came up blank.
  const reports: UsageReport[] = []
  for (const p of profiles) {
    reports.push(
      await (async () => {
      const key = `${serviceId}:${p.name}`
      const cached = cache().get(key)

      // While the provider is still refusing us, keep serving the last good
      // state with its countdown — never re-knock, even on a manual refresh.
      const until = cached?.report.rateLimit?.until
      if (until !== undefined && until > now) return cached!.report

      // A countdown that has run out must poll now. Falling through to the
      // freshness check below kept serving the limited report for the rest of
      // the TTL, which is why the line sat on "retrying…" and never retried.
      const limitFinished = until !== undefined && until <= now

      // Otherwise honour the freshness cache, unless the user forced a poll.
      if (!force && !limitFinished && cached && !cached.stale && now - cached.at < ttl) {
        return cached.report
      }

      // A secret that fails to decrypt (safeStorage keys rotate if the app name
      // ever changes) must not kill the whole poll. The active profile can heal
      // itself — its live credentials are on disk in plaintext, so recapture and
      // re-encrypt them. Anyone else keeps their row with an honest note; the
      // stored blob is never deleted (invariant 4).
      let blob: string | null = null
      try {
        blob = vault.readSecret(serviceId, p.name)
      } catch {
        if (p.name === active) {
          await recaptureLive(a).catch(() => {})
          try {
            blob = vault.readSecret(serviceId, p.name)
          } catch {
            blob = null
          }
        }
        if (!blob) {
          return {
            profileName: p.name,
            windows: [],
            note: 'saved sign-in unreadable. Switch to it once, or add it again',
            plan: cached?.report.plan
          }
        }
      }
      if (!blob) return { profileName: p.name, windows: [], note: 'app session only. Add account for usage' }
      try {
        const result = await a.usage(blob, p.name === active, force, role() === 'owner')
        if (result.updatedBlob) vault.saveSecret(serviceId, p.name, result.updatedBlob)

        // The sign-in is dead: keep the last good windows, flag it so the row
        // offers a same-email re-login, and clear any stale rate-limit line.
        if (result.expired) {
          const base = cached?.report.windows.length
            ? cached.report
            : { profileName: p.name, windows: [] as UsageWindow[] }
          const merged: UsageReport = {
            ...base,
            profileName: p.name,
            note: undefined,
            plan: result.plan ?? base.plan,
            rateLimit: undefined,
            expired: true
          }
          cache().set(key, { at: now, report: merged })
          persistCache()
          return merged
        }

        // Rate limited: keep the last good windows, flag the limit on top. The
        // countdown comes from Retry-After when the provider sends one; without
        // it, back off half a TTL so the auto-poll stops knocking.
        if (result.note === 'usage temporarily unavailable') {
          const base = cached?.report.windows.length
            ? cached.report
            : { profileName: p.name, windows: [] as UsageWindow[] }
          const limitUntil = result.retryAfterMs !== undefined ? now + result.retryAfterMs : undefined
          const merged: UsageReport = {
            ...base,
            profileName: p.name,
            note: undefined,
            plan: result.plan ?? base.plan,
            rateLimit: { provider: a.name, until: limitUntil }
          }
          cache().set(key, { at: limitUntil !== undefined ? now : now - ttl / 2, report: merged })
          persistCache()
          return merged
        }

        const report: UsageReport = {
          profileName: p.name,
          windows: result.windows,
          note: result.note,
          extra: result.extra,
          banked: result.banked,
          // A plan changes about once a year; a failed poll shouldn't make the
          // price line vanish and reappear.
          plan: result.plan ?? cached?.report.plan
        }
        // A non-rate-limit hiccup (session expired mid-poll, etc.): keep the last
        // good numbers rather than blanking the row, and clear any stale limit.
        if (report.windows.length === 0 && report.note && cached?.report.windows.length) {
          const kept: UsageReport = { ...cached.report, rateLimit: undefined }
          cache().set(key, { at: now, report: kept })
          persistCache()
          return kept
        }
        for (const w of report.windows) {
          hooks().onUsageSample?.({ service: serviceId, account: p.name, label: w.label, usedPercent: w.usedPercent, resetsAt: w.resetsAt, periodMs: w.periodMs })
        }
        cache().set(key, { at: now, report })
        persistCache()
        return report
      } catch (e) {
        // Keep the last good numbers, but never re-serve a countdown that has
        // already run out: it would read as "retrying…" for good.
        if (cached) return limitFinished ? { ...cached.report, rateLimit: undefined } : cached.report
        return {
          profileName: p.name,
          windows: [],
          note: `usage unavailable (${(e as Error).message})`
        }
      }
      })()
    )
  }
  return reports
}

/** Test seams: the adapter table and the never-backwards save. */
export const adapterForTest = adapter
export { saveSecretUnlessOlder }
