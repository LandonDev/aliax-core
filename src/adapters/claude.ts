import { fetch } from '../config'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { PlanInfo, UsageWindow } from '../shared/types'
import { isRunning, launchApp, quitApp } from '../apps'
import { readPassword, writePassword } from '../keychain'
import { CLAUDE_CLIENT_ID, CLAUDE_TOKEN_URL } from '../oauth'
import { readCookies, writeCookies, type PlainCookie } from '../chromium-cookies'
import {
  cliProcesses,
  headlessCliProcesses,
  killAndWait,
  reopenSession,
  routedThroughAliax,
  terminalOwns
} from '../procs'
import type { Adapter, Captured, ExtraPath, UsageResult } from './types'
import { retryAfterMs } from './types'

const exec = promisify(execFile)

const KEYCHAIN_SERVICE = 'Claude Code-credentials'
const DESKTOP_APP = 'Claude'
const DESKTOP_DIR = join(homedir(), 'Library/Application Support/Claude')
const DESKTOP_COOKIES = join(DESKTOP_DIR, 'Cookies')
const DESKTOP_SAFE_STORAGE = 'Claude Safe Storage'
/** Session state that determines which claude.ai account the desktop app is logged into. */
const DESKTOP_SESSION = ['Cookies', 'Cookies-journal', 'Local Storage', 'Session Storage']
const DESKTOP_ARCHIVE = 'claude-desktop.tar.gz'
const OAUTH_HEADERS = { 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' }

const claudeJsonPath = (): string => join(homedir(), '.claude.json')

function readOauthAccount(): Record<string, unknown> | null {
  try {
    const account = JSON.parse(readFileSync(claudeJsonPath(), 'utf8')).oauthAccount
    return account && typeof account === 'object' ? account : null
  } catch {
    return null
  }
}

/**
 * A profile can own the desktop app session without any CLI credentials
 * (invariant 7), in which case the blob is just `{ appSession }` — so treat a
 * missing or unparsable keychain half as "no tokens" rather than throwing.
 * `JSON.parse(undefined)` surfaced to the user as `"undefined" is not valid JSON`.
 */
function parseTokens(blob: string): {
  keychain?: string
  oauthAccount: unknown
  tokens: Record<string, unknown>
} {
  const { keychain, oauthAccount } = JSON.parse(blob)
  if (typeof keychain !== 'string') return { keychain: undefined, oauthAccount, tokens: {} }
  try {
    return { keychain, oauthAccount, tokens: JSON.parse(keychain)?.claudeAiOauth ?? {} }
  } catch {
    return { keychain, oauthAccount, tokens: {} }
  }
}

/**
 * Whose claude.ai session is this? Asked of the API with the session cookie, so it
 * cannot be fooled by cached storage (invariant 3). Cached per session key.
 */
let appIdCache: { key: string; email: string | null } | null = null

export async function appSessionEmail(cookies: PlainCookie[]): Promise<string | null> {
  const sessionKey = cookies.find((c) => c.name === 'sessionKey')?.value
  if (!sessionKey) return null
  const key = createHash('sha256').update(sessionKey).digest('hex')
  if (appIdCache?.key === key) return appIdCache.email
  // A null account means the session is dead (the app rotates its key and only
  // flushes to disk on quit, so a scraped one is often already invalid).
  const res = await fetch('https://claude.ai/api/bootstrap', { headers: { Cookie: `sessionKey=${sessionKey}` } })
    .catch(() => null)
  if (!res?.ok) return null
  const data = (await res.json().catch(() => null)) as
    | { account?: { email_address?: string; email?: string } | null }
    | null
  const email = data?.account?.email_address ?? data?.account?.email ?? null
  appIdCache = { key, email }
  return email
}

/** Read the desktop app's live claude.ai cookies so a switch can put them back later. */
async function readAppSession(): Promise<PlainCookie[] | null> {
  if (!existsSync(DESKTOP_COOKIES)) return null
  const cookies = await readCookies(DESKTOP_COOKIES, DESKTOP_SAFE_STORAGE, 'claude.ai').catch(
    () => [] as PlainCookie[]
  )
  return cookies.some((c) => c.name === 'sessionKey') ? cookies : null
}

/** Install a saved claude.ai session into the desktop app. Requires the app to be quit. */
async function installAppSession(cookies: PlainCookie[]): Promise<void> {
  await writeCookies(DESKTOP_COOKIES, DESKTOP_SAFE_STORAGE, cookies, ['claude.ai'])
  // Local Storage caches the previous account's profile; clearing forces a re-read
  // from the session cookie on next launch.
  for (const stale of ['Local Storage', 'Session Storage']) {
    rmSync(join(DESKTOP_DIR, stale), { recursive: true, force: true })
  }
}

/** Ask the API who this token belongs to — immune to a clobbered ~/.claude.json. */
async function fetchIdentity(
  accessToken: string
): Promise<{ uuid: string; email?: string; oauthAccount: Record<string, unknown> } | null> {
  const data = await fetchProfile(accessToken)
  if (!data?.account?.uuid) return null
  // The profile endpoint returns `email`; the token endpoint returns `email_address`.
  const email = data.account.email ?? data.account.email_address
  const org = data.organization as { uuid?: string; name?: string } | undefined
  return {
    uuid: data.account.uuid,
    email,
    oauthAccount: {
      accountUuid: data.account.uuid,
      emailAddress: email,
      organizationUuid: org?.uuid,
      organizationName: org?.name
    }
  }
}

async function refreshTokens(tokens: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  if (typeof tokens.refreshToken !== 'string') return null
  const res = await fetch(CLAUDE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
      client_id: CLAUDE_CLIENT_ID
    })
  }).catch(() => null)
  if (!res?.ok) return null
  const data = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number }
  if (!data.access_token) return null
  return {
    ...tokens,
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? tokens.refreshToken,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000
  }
}

/**
 * Plan prices are a lookup, not something the API returns: the profile gives a
 * rate-limit tier and a billing anchor, never a dollar figure. Anything not
 * listed here shows its tier name without a price rather than guessing.
 */
const PLAN_PRICES: { match: RegExp; name: string; monthlyUsd: number }[] = [
  { match: /max_20x/, name: 'Max 20x', monthlyUsd: 200 },
  { match: /max_5x/, name: 'Max 5x', monthlyUsd: 100 },
  { match: /pro/, name: 'Pro', monthlyUsd: 20 }
]

interface SubDetails {
  next_charge_at?: string | null
  plan_ending_at?: string | null
  status?: string | null
}

const subCache = new Map<
  string,
  { at: number; data: { renewsAt?: number; cancelsAt?: number; status?: string } }
>()

/**
 * The real billing date, read from claude.ai's Stripe-backed subscription page
 * with the account's own web session. The OAuth token carries no billing date,
 * and a date projected from the signup day is wrong the moment a plan is upgraded
 * mid-cycle: Stripe moves the charge day but leaves the signup day untouched. So
 * a renewal date is only ever shown when this endpoint confirms it. Cached per
 * session and org for an hour, skipped on a manual Refresh.
 */
async function verifiedSubscription(
  sessionKey: string,
  orgUuid: string,
  force?: boolean
): Promise<{ renewsAt?: number; cancelsAt?: number; status?: string } | null> {
  const key = createHash('sha256').update(`${sessionKey}:${orgUuid}`).digest('hex')
  const hit = subCache.get(key)
  if (!force && hit && Date.now() - hit.at < 3_600_000) return hit.data
  // A failed read is left uncached, so a session that comes back healthy shows a
  // date on the next poll instead of waiting out an hour of staleness.
  const res = await fetch(`https://claude.ai/api/organizations/${orgUuid}/subscription_details`, {
      headers: { Cookie: `sessionKey=${sessionKey}` }
    })
    .catch(() => null)
  if (!res?.ok) return null
  const d = (await res.json().catch(() => null)) as SubDetails | null
  if (!d) return null
  const ends = d.plan_ending_at ? Date.parse(d.plan_ending_at) : NaN
  const charge = d.next_charge_at ? Date.parse(d.next_charge_at) : NaN
  const data = {
    // A pending cancellation ends access on plan_ending_at and takes no next charge.
    cancelsAt: Number.isFinite(ends) ? ends : undefined,
    renewsAt: Number.isFinite(ends) ? undefined : Number.isFinite(charge) ? charge : undefined,
    status: typeof d.status === 'string' ? d.status : undefined
  }
  subCache.set(key, { at: Date.now(), data })
  return data
}

interface Profile {
  account?: { uuid?: string; email?: string; email_address?: string }
  organization?: Record<string, unknown>
}

const profileCache = new Map<string, { at: number; profile: Profile | null }>()
const inFlight = new Map<string, Promise<Profile | null>>()

/**
 * The account profile, fetched at most once per token per hour and shared by
 * every caller. Identity, plan and the proxy all wanted it, and three separate
 * requests per poll was enough for the endpoint to start refusing some of them —
 * which showed up as a plan line on one account and nothing on the rest.
 */
async function fetchProfile(accessToken: string, force?: boolean): Promise<Profile | null> {
  const key = createHash('sha256').update(accessToken).digest('hex')
  const hit = profileCache.get(key)
  // A manual Refresh skips this cache too: plan and subscription status live
  // here, and holding them an hour makes a just-made billing change look ignored.
  if (!force && hit && Date.now() - hit.at < 3_600_000) return hit.profile
  const pending = inFlight.get(key)
  if (pending) return pending

  const work = (async (): Promise<Profile | null> => {
    try {
      const res = await fetch('https://api.anthropic.com/api/oauth/profile', {
        headers: { Authorization: `Bearer ${accessToken}`, ...OAUTH_HEADERS }
      })
      if (!res.ok) return null
      const profile = (await res.json()) as Profile
      profileCache.set(key, { at: Date.now(), profile })
      return profile
    } catch {
      return null
    } finally {
      inFlight.delete(key)
    }
  })()
  inFlight.set(key, work)
  return work
}

/** Plan, price and renewal for a token's account. */
export async function planForToken(
  accessToken: string,
  force?: boolean,
  appSession?: PlainCookie[] | null
): Promise<PlanInfo | null> {
  const org = (await fetchProfile(accessToken, force))?.organization
  if (!org) return null
  const tier = String(org.rate_limit_tier ?? org.organization_type ?? '')
  const priced = PLAN_PRICES.find((p) => p.match.test(tier))
  const oauthStatus =
    typeof org.subscription_status === 'string' ? org.subscription_status : undefined

  // The real billing date lives only on claude.ai, behind the account's web
  // session. Without one we show the plan and its price but no renewal date —
  // better a missing date than a projected one that a plan upgrade silently
  // breaks (invariant: never show a billing date we cannot confirm).
  const sessionKey = appSession?.find((c) => c.name === 'sessionKey')?.value
  const orgUuid = typeof org.uuid === 'string' ? org.uuid : undefined
  const verified =
    sessionKey && orgUuid
      ? await verifiedSubscription(sessionKey, orgUuid, force).catch(() => null)
      : null

  return {
    name: priced?.name ?? (tier.replace(/^default_claude_/, '').replace(/_/g, ' ') || 'Unknown plan'),
    monthlyUsd: priced?.monthlyUsd,
    renewsAt: verified?.renewsAt,
    cancelsAt: verified?.cancelsAt,
    status: verified?.status ?? oauthStatus
  }
}

const tokenIdCache = new Map<string, string | null>()

/** Which account an access token belongs to, cached per token. */
export async function accountIdForToken(accessToken: string): Promise<string | null> {
  const key = createHash('sha256').update(accessToken).digest('hex')
  const cached = tokenIdCache.get(key)
  if (cached !== undefined) return cached
  const identity = await fetchIdentity(accessToken).catch(() => null)
  const id = identity?.uuid ?? null
  if (id) tokenIdCache.set(key, id)
  return id
}

/** The Claude Code CLI's own credentials, straight from the Keychain. */
export async function liveKeychain(): Promise<string | null> {
  return readPassword(KEYCHAIN_SERVICE).catch(() => null)
}

let liveIdCache: { key: string; accountId: string; email?: string } | null = null

/**
 * The single resolver for "who is the CLI signed in as" — the active dot and the
 * CLI badge both come from here, so they can never disagree. The API answer is
 * cached per access token; the cache is only trusted when its key matches the
 * CURRENT token, so a failed lookup can never serve the previous account.
 */
async function liveCliIdentity(): Promise<{ accountId: string; email?: string } | null> {
  try {
    const tokens = JSON.parse(await readPassword(KEYCHAIN_SERVICE))?.claudeAiOauth
    if (typeof tokens?.accessToken === 'string') {
      const key = createHash('sha256').update(tokens.accessToken).digest('hex')
      if (liveIdCache?.key === key) {
        return { accountId: liveIdCache.accountId, email: liveIdCache.email }
      }
      const identity = await fetchIdentity(tokens.accessToken)
      if (identity) {
        liveIdCache = { key, accountId: identity.uuid, email: identity.email }
        return { accountId: identity.uuid, email: identity.email }
      }
    }
  } catch {
    // keychain unreadable or offline; fall back to the metadata file
  }
  const account = readOauthAccount()
  if (typeof account?.accountUuid !== 'string') return null
  return {
    accountId: account.accountUuid,
    email: typeof account.emailAddress === 'string' ? account.emailAddress : undefined
  }
}

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]{2,}/g

/**
 * Best-effort read of which account a claude.ai desktop session belongs to. The
 * signed-in address appears in the app's Local Storage; cookie values are encrypted,
 * so this is a hint for the user, never a gate on any action.
 */
function sessionEmail(dir: string): string | null {
  const counts = new Map<string, number>()
  for (const sub of ['Local Storage/leveldb', 'Session Storage']) {
    const path = join(dir, sub)
    if (!existsSync(path)) continue
    try {
      for (const f of readdirSync(path)) {
        if (!/\.(ldb|log)$/.test(f)) continue
        const text = readFileSync(join(path, f)).toString('utf8')
        for (const match of text.match(EMAIL_RE) ?? []) {
          if (match.length < 7 || match.endsWith('.png') || match.endsWith('.js')) continue
          counts.set(match, (counts.get(match) ?? 0) + 1)
        }
      }
    } catch {
      // unreadable storage; fall through
    }
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
  return best?.[0] ?? null
}

/** Session id of the newest local session for a working directory. */
function latestSessionFor(cwd: string): string | null {
  const dir = join(homedir(), '.claude/projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  if (!existsSync(dir)) return null
  let best: { id: string; mtime: number } | null = null
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.jsonl')) continue
    const mtime = statSync(join(dir, f)).mtimeMs
    if (!best || mtime > best.mtime) best = { id: f.slice(0, -6), mtime }
  }
  return best?.id ?? null
}

const WINDOW_LABELS: Record<string, string> = {
  five_hour: '5h',
  seven_day: 'week',
  seven_day_opus: 'Opus',
  seven_day_sonnet: 'Sonnet',
  seven_day_fable: 'Fable',
  seven_day_cowork: 'Cowork'
}

/** Always-present windows. Everything else is a per-model cap. */
const BASE_WINDOWS = new Set(['five_hour', 'seven_day'])

interface ApiLimit {
  kind?: string
  group?: string
  percent?: number
  resets_at?: string
  scope?: { model?: { display_name?: string | null } | null } | null
}

/**
 * Usage windows for a Claude account.
 *
 * The authoritative shape is the `limits` array, not the top-level keys: the
 * per-model caps arrive there as `weekly_scoped` entries carrying their own
 * `scope.model.display_name` (e.g. "Fable"), while the matching top-level keys
 * (`seven_day_fable`, …) simply do not exist. Reading only the keys is why a
 * model cap sitting at 63% was invisible. Keys stay as a fallback for accounts
 * the newer shape has not reached.
 */
/** Windows on success; on failure the status code, plus retry-ms on a 429. */
type UsageFetch = UsageWindow[] | { status: number; retryAfterMs?: number }

async function fetchUsageWindows(accessToken: string): Promise<UsageFetch> {
  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: { Authorization: `Bearer ${accessToken}`, ...OAUTH_HEADERS }
  })
  if (!res.ok) {
    return { status: res.status, retryAfterMs: res.status === 429 ? retryAfterMs(res) : undefined }
  }
  return parseClaudeUsage((await res.json()) as Record<string, unknown>)
}

/** Windows from the usage endpoint's JSON. Exported for tests. */
export function parseClaudeUsage(body: Record<string, unknown> & { limits?: ApiLimit[] }): UsageWindow[] {
  const windows: UsageWindow[] = []

  const at = (iso?: string): number | undefined => {
    const t = iso ? Date.parse(iso) : NaN
    return Number.isNaN(t) ? undefined : t
  }

  for (const l of body.limits ?? []) {
    if (typeof l.percent !== 'number') continue
    const weekly = l.group === 'weekly'
    const model = l.scope?.model?.display_name ?? null
    // A per-model cap only earns a bar once it has been used; at zero it would
    // be a full bar saying nothing.
    if (l.kind === 'weekly_scoped' && (!model || l.percent <= 0)) continue
    windows.push({
      label: l.kind === 'session' ? '5h' : l.kind === 'weekly_all' ? 'Weekly' : (model as string),
      usedPercent: l.percent,
      periodMs: weekly ? 7 * 86_400_000 : 5 * 3_600_000,
      resetsAt: at(l.resets_at)
    })
  }
  if (windows.length > 0) return windows

  // Older shape: named top-level windows.
  for (const [key, value] of Object.entries(body)) {
    if (!value || typeof value !== 'object' || !('utilization' in value)) continue
    const { utilization, resets_at } = value as { utilization: unknown; resets_at?: unknown }
    if (typeof utilization !== 'number') continue
    if (!BASE_WINDOWS.has(key) && utilization <= 0) continue
    windows.push({
      label: WINDOW_LABELS[key] ?? key.replace(/_/g, ' '),
      usedPercent: utilization,
      periodMs: key === 'five_hour' ? 5 * 3_600_000 : 7 * 86_400_000,
      resetsAt:
        typeof resets_at === 'string'
          ? Date.parse(resets_at)
          : typeof resets_at === 'number'
            ? resets_at * 1000
            : undefined
    })
  }
  return windows
}

export const claude: Adapter = {
  id: 'claude-code',
  name: 'Claude Code',
  billingUrl: 'https://claude.ai/settings/billing',
  supportsLogin: true,
  targets: [
    { id: 'cli', label: 'Restart terminal sessions' },
    { id: 'desktop', label: 'Claude desktop app' }
  ],

  detect: () => existsSync(join(homedir(), '.claude')),

  async liveAccountId() {
    return (await liveCliIdentity())?.accountId ?? null
  },

  async liveFingerprint() {
    try {
      const tokens = JSON.parse(await readPassword(KEYCHAIN_SERVICE))?.claudeAiOauth
      if (typeof tokens?.refreshToken !== 'string') return null
      return createHash('sha256').update(tokens.refreshToken).digest('hex')
    } catch {
      return null
    }
  },

  /** The CLI's OAuth token and the desktop app's claude.ai session are separate logins. */
  async liveSurfaces() {
    const cli = await liveCliIdentity()
    const live = existsSync(DESKTOP_DIR) ? await readAppSession() : null
    return {
      CLI: cli?.email ?? null,
      App: live ? await appSessionEmail(live) : null
    }
  },

  async identify(blob: string) {
    const { tokens } = parseTokens(blob)
    if (typeof tokens.accessToken !== 'string') return null
    const identity = await fetchIdentity(tokens.accessToken)
    return identity ? { accountId: identity.uuid, email: identity.email } : null
  },

  fingerprintOf(blob: string) {
    try {
      const { tokens } = parseTokens(blob)
      if (typeof tokens.refreshToken !== 'string') return null
      return createHash('sha256').update(tokens.refreshToken).digest('hex')
    } catch {
      return null
    }
  },

  /** Snapshot order for one account: the token's own expiry. Newer token, later expiry. */
  freshness(blob: string) {
    try {
      const exp = parseTokens(blob).tokens.expiresAt
      return typeof exp === 'number' ? exp : null
    } catch {
      return null
    }
  },

  async liveCredentialExpired() {
    try {
      const exp = JSON.parse((await liveKeychain()) ?? '')?.claudeAiOauth?.expiresAt
      return typeof exp === 'number' && Date.now() > exp
    } catch {
      return false
    }
  },

  async capture(_extra: ExtraPath): Promise<Captured> {
    const keychain = await readPassword(KEYCHAIN_SERVICE)
    const tokens = JSON.parse(keychain)?.claudeAiOauth
    const fileAccount = readOauthAccount()

    // Identity comes from the token itself when possible, so a stale ~/.claude.json
    // (rewritten by running sessions) can never mislabel a capture.
    const identity = typeof tokens?.accessToken === 'string' ? await fetchIdentity(tokens.accessToken) : null
    const accountId = identity?.uuid ?? (typeof fileAccount?.accountUuid === 'string' ? fileAccount.accountUuid : null)
    if (!accountId) throw new Error('could not identify the logged-in account')
    const email =
      identity?.email ?? (typeof fileAccount?.emailAddress === 'string' ? fileAccount.emailAddress : undefined)
    const oauthAccount =
      fileAccount?.accountUuid === accountId ? fileAccount : (identity?.oauthAccount ?? fileAccount)

    // Keep the app session in the profile when it belongs to this same account,
    // so every profile carries both halves. Ownership comes from the API.
    let appSession: PlainCookie[] | null = null
    let note: string | undefined
    const live = await readAppSession()
    const appEmail = live ? await appSessionEmail(live) : null
    if (live && appEmail) {
      if (!email || appEmail.toLowerCase() === email.toLowerCase()) {
        appSession = live
        note = 'CLI and app both linked'
      } else {
        note = `app half belongs to ${appEmail}; saved under that account instead`
      }
    } else {
      // Only ever store a session the API confirms; a dead one would switch the
      // desktop app into a logged-out state.
      note = 'app half not captured. Use Add account to link the Claude app'
    }

    return {
      accountId,
      email,
      note,
      blob: JSON.stringify({ keychain, oauthAccount, appSession })
    }
  },

  /**
   * The desktop app's claude.ai session, filed under the account IT is signed into
   * (which may differ from the CLI's). This is the link that lets a switch move
   * the CLI and the app in tandem: each profile owns its own copy of each surface.
   */
  async captureCompanion(): Promise<Captured | null> {
    if (!existsSync(DESKTOP_DIR)) return null
    const appSession = await readAppSession()
    if (!appSession) return null
    const desktopEmail = await appSessionEmail(appSession)
    if (!desktopEmail) return null
    return {
      accountId: desktopEmail,
      email: desktopEmail,
      appSession,
      note: `app session saved for ${desktopEmail}`
    }
  },

  async activate(blob: string | null, extra: ExtraPath, on: Set<string>): Promise<string[]> {
    const notes: string[] = []
    if (blob === null) {
      notes.push('CLI unchanged. No CLI sign-in saved for this account')
      if (on.has('desktop')) notes.push(...(await restoreDesktopSession(extra(DESKTOP_ARCHIVE))))
      return notes
    }
    const { keychain, oauthAccount, appSession } = JSON.parse(blob) as {
      keychain: string
      oauthAccount: Record<string, unknown> | null
      appSession?: PlainCookie[] | null
    }
    const accountId =
      oauthAccount && typeof oauthAccount.accountUuid === 'string' ? oauthAccount.accountUuid : null

    // Refuse to install tokens that belong to a different account than this profile
    // claims (possible for profiles saved before identity became token-derived).
    const tokens = JSON.parse(keychain)?.claudeAiOauth
    if (accountId && typeof tokens?.accessToken === 'string') {
      const identity = await fetchIdentity(tokens.accessToken)
      if (identity && identity.uuid !== accountId) {
        throw new Error(
          `this saved sign-in belongs to ${identity.email ?? 'another account'}. Add the account again`
        )
      }
    }

    // Kill running CLI sessions first — alive, they rewrite the old account's
    // credentials; dead, their threads resume under the new account below.
    // One rule for every host: a session is ours to restart only if a terminal
    // we can script owns it, so we can put it back exactly where it was.
    // Everything else — an editor's built-in terminal (T3 Code, VS Code), a
    // wrapper's background agent — runs in a pty we cannot drive, so it is left
    // alone and reported. Instant switching, not a restart, is what covers
    // those. No per-application special cases.
    const candidates = on.has('cli') ? await cliProcesses('claude') : []
    const sessions: typeof candidates = []
    const untouched: typeof candidates = []
    for (const s of candidates) {
      ;(await terminalOwns(s.tty)) ? sessions.push(s) : untouched.push(s)
    }
    // Of the ones we cannot restart, those already routed through Aliax follow
    // the switch on their own. Only the rest are genuinely stuck on the old
    // account, and saying so about all of them contradicted the very next line.
    const followed: typeof candidates = []
    const stranded: typeof candidates = []
    for (const s of untouched) {
      ;(await routedThroughAliax(s.pid)) ? followed.push(s) : stranded.push(s)
    }

    // Sessions an editor drives over pipes (T3 Code and anything else on the
    // agent SDK) have no terminal at all, so they never reach the lists above.
    // Nothing outside their host can restart them, and staying silent about
    // them is what made a switch look like it had simply not worked.
    // Snapshot them BEFORE the keychain write below: one spawned after it is
    // already on the new account and must not be reported as stale.
    const headless = on.has('cli') ? await headlessCliProcesses('claude') : []
    const headlessStranded: number[] = []
    for (const pid of headless) {
      if (!(await routedThroughAliax(pid))) headlessStranded.push(pid)
    }

    if (sessions.length > 0) await killAndWait(sessions.map((s) => s.pid))

    await writePassword(KEYCHAIN_SERVICE, userInfo().username, keychain)

    if (oauthAccount && existsSync(claudeJsonPath())) {
      const raw = readFileSync(claudeJsonPath(), 'utf8')
      const json = JSON.parse(raw)
      json.oauthAccount = oauthAccount
      writeFileSync(claudeJsonPath(), JSON.stringify(json, null, raw.startsWith('{\n') ? 2 : 0))
    }

    let resumed = 0
    for (const s of sessions) {
      const sessionId = s.cwd ? latestSessionFor(s.cwd) : null
      if (await reopenSession(s, sessionId ? `claude --resume ${sessionId}` : 'claude --continue')) {
        resumed++
      }
    }
    if (resumed > 0) {
      notes.push(`resumed ${resumed} claude session${resumed > 1 ? 's' : ''} in place`)
    }
    if (followed.length > 0) {
      const n = followed.length
      notes.push(`${n} running session${n > 1 ? 's' : ''} switched without restarting`)
      // The CLI asks api.anthropic.com for /usage directly, never through the
      // base URL we set (verified: the panel renders while our proxy logs
      // nothing). So /usage keeps naming the old account even though the work
      // is going to the new one. Say it plainly; it reads as a failed switch.
      notes.push('/usage in those sessions still names the old account')
    }
    if (stranded.length > 0) {
      const n = stranded.length
      notes.push(
        `${n} session${n > 1 ? 's' : ''} still on the old account. Restart ${n > 1 ? 'them' : 'it'}, or turn on instant switching`
      )
    }
    if (headlessStranded.length > 0) {
      const n = headlessStranded.length
      notes.push(
        `${n} session${n > 1 ? 's' : ''} inside another app still on the old account. Restart ${n > 1 ? 'them' : 'it'} there, or turn on instant switching`
      )
    }

    if (
      sessions.length === 0 &&
      untouched.length === 0 &&
      headless.length === 0
    ) {
      notes.push('takes effect for new claude sessions')
    }

    if (on.has('desktop') && existsSync(DESKTOP_DIR)) {
      if (appSession && appSession.length > 0) {
        const wasRunning = await isRunning(DESKTOP_APP).catch(() => false)
        if (wasRunning) await quitApp(DESKTOP_APP)
        await installAppSession(appSession)
        notes.push(wasRunning ? 'Claude app switched and restarted' : 'Claude app switched')
        if (wasRunning) await launchApp(DESKTOP_APP)
      } else {
        const email = typeof oauthAccount?.emailAddress === 'string' ? oauthAccount.emailAddress : undefined
        notes.push(...(await restoreDesktopSession(extra(DESKTOP_ARCHIVE), email)))
      }
    }
    return notes
  },

  async usage(blob: string, isActive: boolean, force?: boolean, mayRefresh = true): Promise<UsageResult> {
    // The active account's vault copy is stale within the hour — the CLI renews
    // the Keychain token itself (invariant 16). Poll with the LIVE credential
    // and adopt it back; the caller already proved the live account is this
    // profile's before setting isActive. Rate limits are bucketed per token,
    // so polling with a dead snapshot can 429 while the real login is healthy.
    // The web session gives the real renewal date; grab it before the active
    // account's adoption below rewrites the blob without it.
    const appSession = ((): PlainCookie[] | null => {
      try {
        return (JSON.parse(blob).appSession as PlainCookie[] | null) ?? null
      } catch {
        return null
      }
    })()
    let adopted: string | undefined
    if (isActive) {
      const live = await liveKeychain()
      const stored = parseTokens(blob)
      // Adopt only a live token at least as fresh as the stored one. After a
      // re-sign-in the vault holds the NEW grant while the Keychain still holds
      // the dead one — adopting backwards would clobber the repair, and the
      // dead-token branch below would then persist the clobber.
      const liveExp = ((): unknown => {
        try {
          return JSON.parse(live ?? '')?.claudeAiOauth?.expiresAt
        } catch {
          return undefined
        }
      })()
      const olderThanStored =
        typeof liveExp === 'number' &&
        typeof stored.tokens.expiresAt === 'number' &&
        liveExp < stored.tokens.expiresAt
      // The caller proved the live account was this profile's when the poll
      // began, but a switch can land in between. Prove it again against the
      // live token itself, or a poll in flight during a switch adopts the new
      // account's token into the old profile (invariant 1).
      const storedId = (stored.oauthAccount as { accountUuid?: unknown } | undefined)?.accountUuid
      const liveId = live ? (await liveCliIdentity())?.accountId : undefined
      const sameAccount = typeof storedId === 'string' && liveId === storedId
      if (live && sameAccount && live !== stored.keychain && !olderThanStored) {
        adopted = JSON.stringify({
          keychain: live,
          oauthAccount: JSON.parse(blob).oauthAccount,
          ...(appSession ? { appSession } : {})
        })
        blob = adopted
      }
    }
    const { keychain, oauthAccount, tokens } = parseTokens(blob)
    if (typeof tokens.accessToken !== 'string') {
      // This profile owns the Claude app session but no CLI sign-in, so there
      // is no usage to report — say what it is, not that something failed.
      return {
        windows: [],
        note:
          keychain === undefined
            ? 'app session only. Add account for usage'
            : 'no token saved'
      }
    }

    // Plan is resolved once, up front, and attached to EVERY return: it depends
    // only on the token, so an account whose usage call fails should still show
    // what it costs. Computing it on the success path alone left every account
    // but the one being polled without a plan line.
    const plan =
      (await planForToken(tokens.accessToken, force, appSession).catch(() => null)) ?? undefined

    // A dead token doesn't always answer 401/403 — Anthropic's gateway returns
    // 429 for one too, which read as "rate limited" when it was really expired.
    // The honest discriminator is the token's own clock: a genuine throttle only
    // happens on a live token, so a 429 past expiry is a dead token, not a limit.
    const expiredNow = typeof tokens.expiresAt === 'number' && Date.now() > tokens.expiresAt
    let result = await fetchUsageWindows(tokens.accessToken)
    const authFail = !Array.isArray(result) && (result.status === 401 || result.status === 403)
    const deadToken = authFail || (!Array.isArray(result) && result.status === 429 && expiredNow)
    if (deadToken) {
      // The CLI owns the active account's token and renews it itself; refreshing
      // here with a superseded refresh token surfaces as "OAuth revoked"
      // (invariant 16). So the active account only reports — it never refreshes.
      if (isActive) return { plan, windows: [], expired: true, updatedBlob: adopted }
      if (!mayRefresh)
        return { plan, windows: [], note: 'waiting for the gateway owner to refresh', updatedBlob: adopted }
      const refreshed = await refreshTokens(tokens)
      if (!refreshed) return { plan, windows: [], expired: true }
      // Keep the app-session half: dropping it here stripped the claude.ai
      // cookies from the vault copy on every background refresh.
      const refreshedBlob = JSON.stringify({
        keychain: JSON.stringify({ claudeAiOauth: refreshed }),
        oauthAccount,
        ...(appSession ? { appSession } : {})
      })
      result = await fetchUsageWindows(refreshed.accessToken as string)
      if (!Array.isArray(result)) {
        if (result.status === 429)
          return {
            plan,
            windows: [],
            note: 'usage temporarily unavailable',
            retryAfterMs: result.retryAfterMs,
            updatedBlob: refreshedBlob
          }
        return { plan, windows: [], note: `usage unavailable (${result.status})`, updatedBlob: refreshedBlob }
      }
      return {
        plan:
          (await planForToken(refreshed.accessToken as string, force, appSession).catch(
            () => null
          )) ?? plan,
        windows: result,
        updatedBlob: refreshedBlob
      }
    }
    if (!Array.isArray(result)) {
      if (result.status === 429)
        return {
          plan,
          windows: [],
          note: 'usage temporarily unavailable',
          retryAfterMs: result.retryAfterMs,
          updatedBlob: adopted
        }
      return { plan, windows: [], note: `usage unavailable (${result.status})`, updatedBlob: adopted }
    }
    return { plan, windows: result, updatedBlob: adopted }
  }
}

/**
 * Restore the desktop session saved with this profile. The archive is never verified
 * against the CLI account (the desktop app's leveldb keeps traces of every account
 * that ever signed in, so byte matching lies) and never deleted.
 */
async function restoreDesktopSession(archive: string, profileEmail?: string): Promise<string[]> {
  if (!existsSync(DESKTOP_DIR)) return []
  if (!existsSync(archive)) {
    return ['Claude app unchanged. Log it into this account, then Save current']
  }

  const tmp = mkdtempSync(join(tmpdir(), 'aliax-claude-'))
  try {
    await exec('tar', ['-xzf', archive, '-C', tmp])
    const savedEmail = sessionEmail(tmp)
    // The desktop app logs in separately, so a profile can carry another account's
    // session. Say so rather than restoring it silently and looking like a no-op.
    if (savedEmail && profileEmail && savedEmail !== profileEmail) {
      return [
        `Claude app left alone. Its saved session is ${savedEmail}, not ${profileEmail}. Log the app in, then Save current.`
      ]
    }
    const wasRunning = await isRunning(DESKTOP_APP)
    if (wasRunning) await quitApp(DESKTOP_APP)
    for (const m of DESKTOP_SESSION) {
      rmSync(join(DESKTOP_DIR, m), { recursive: true, force: true })
      if (existsSync(join(tmp, m))) cpSync(join(tmp, m), join(DESKTOP_DIR, m), { recursive: true })
    }
    const who = savedEmail ? ` (${savedEmail})` : ''
    if (wasRunning) {
      await launchApp(DESKTOP_APP)
      return [`Claude app restarted${who}`]
    }
    return [`Claude app session restored${who}`]
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}
