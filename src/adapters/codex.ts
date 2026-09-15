import { fetch } from '../config'
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { OPENAI_CLIENT_ID, OPENAI_TOKEN_URL } from '../oauth'
import type { PlanInfo, UsageWindow } from '../shared/types'
import { isRunning, launchApp, quitApp } from '../apps'
import { cliProcesses, killAndWait, reopenSession, terminalOwns } from '../procs'
import type { Adapter, Captured, UsageResult } from './types'
import { decodeJwtPayload, retryAfterMs } from './types'

const CODEX_DIR = join(homedir(), '.codex')
const AUTH_PATH = join(CODEX_DIR, 'auth.json')
const DESKTOP_APP = 'Codex'
const DESKTOP_APP_PATH = '/Applications/Codex.app'

function identity(authJson: string): { accountId: string; email?: string } {
  const auth = JSON.parse(authJson)
  let email: string | undefined
  try {
    const payload = decodeJwtPayload(auth.tokens.id_token)
    if (typeof payload.email === 'string') email = payload.email
  } catch {
    // no id_token (e.g. API-key auth); fall through
  }
  const accountId = auth.tokens?.account_id ?? email
  if (!accountId) throw new Error('no account identity in auth.json')
  return { accountId, email }
}

export function windowLabel(minutes: number | undefined): string {
  if (minutes === undefined) return 'usage'
  if (minutes === 10080) return 'week'
  if (minutes <= 600) return `${Math.round(minutes / 60)}h`
  return `${Math.round(minutes / 1440)}d`
}

interface ApiWindow {
  used_percent?: number
  limit_window_seconds?: number
  reset_at?: number
}
interface ApiRateLimit {
  primary_window?: ApiWindow | null
  secondary_window?: ApiWindow | null
}

function pushApiWindows(windows: UsageWindow[], rl: ApiRateLimit | undefined, labelOverride?: string): void {
  for (const w of [rl?.primary_window, rl?.secondary_window]) {
    if (!w || typeof w.used_percent !== 'number') continue
    windows.push({
      label: labelOverride ?? windowLabel(w.limit_window_seconds ? w.limit_window_seconds / 60 : undefined),
      usedPercent: w.used_percent,
      periodMs: w.limit_window_seconds ? w.limit_window_seconds * 1000 : undefined,
      resetsAt: typeof w.reset_at === 'number' ? w.reset_at * 1000 : undefined
    })
  }
}

/** 401/403 → null (needs auth); other failures throw. Uses Chromium's stack to pass Cloudflare. */
async function fetchApiUsage(auth: {
  tokens?: { access_token?: string; account_id?: string }
}): Promise<{ windows: UsageWindow[]; banked?: number } | null> {
  const { access_token, account_id } = auth.tokens ?? {}
  if (!access_token) throw new Error('no token')
  const headers: Record<string, string> = { Authorization: `Bearer ${access_token}` }
  if (account_id) headers['chatgpt-account-id'] = account_id
  const res = await fetch('https://chatgpt.com/backend-api/codex/usage', { headers })
  if (res.status === 401 || res.status === 403) return null
  if (!res.ok) {
    const err = new Error(`${res.status}`) as Error & { retryAfterMs?: number }
    if (res.status === 429) err.retryAfterMs = retryAfterMs(res)
    throw err
  }
  const data = (await res.json()) as {
    rate_limit?: ApiRateLimit
    additional_rate_limits?: { limit_name?: string; rate_limit?: ApiRateLimit }[]
    rate_limit_reset_credits?: { available_count?: number }
  }
  const windows: UsageWindow[] = []
  pushApiWindows(windows, data.rate_limit)
  for (const add of data.additional_rate_limits ?? []) {
    const label = add.limit_name?.split(/[- ]/).pop()?.toLowerCase()
    // A model-specific cap (Spark) only earns a bar once this cycle has
    // actually touched it; an untouched cap at 100% left is just noise.
    const extra: UsageWindow[] = []
    pushApiWindows(extra, add.rate_limit, label)
    windows.push(...extra.filter((w) => w.usedPercent > 0))
  }
  const banked = data.rate_limit_reset_credits?.available_count
  return { windows, banked: typeof banked === 'number' ? banked : undefined }
}

/**
 * OpenAI stamps the subscription into every id_token under the
 * `https://api.openai.com/auth` claim: `chatgpt_plan_type` plus
 * `chatgpt_subscription_active_until`, which on an auto-renewing plan is the
 * next billing date. No endpoint call needed — and the claims stay current
 * because every token refresh mints a new id_token (invariant 17 keeps stored
 * blobs rotating). Decode only; an expired token still reads fine.
 */
const CODEX_PLANS: Record<string, { name: string; monthlyUsd?: number }> = {
  free: { name: 'Free', monthlyUsd: 0 },
  plus: { name: 'Plus', monthlyUsd: 20 },
  pro: { name: 'Pro', monthlyUsd: 200 },
  team: { name: 'Team' },
  business: { name: 'Business' },
  enterprise: { name: 'Enterprise' }
}

function planFromAuth(authJson: string): PlanInfo | undefined {
  try {
    const claims = decodeJwtPayload(JSON.parse(authJson).tokens.id_token)
    const auth = claims['https://api.openai.com/auth'] as
      | { chatgpt_plan_type?: string; chatgpt_subscription_active_until?: string }
      | undefined
    const type = auth?.chatgpt_plan_type
    if (!type) return undefined
    const tier = CODEX_PLANS[type] ?? { name: type.charAt(0).toUpperCase() + type.slice(1) }
    const until = Date.parse(auth?.chatgpt_subscription_active_until ?? '')
    return {
      name: tier.name,
      monthlyUsd: tier.monthlyUsd,
      renewsAt: Number.isFinite(until) ? until : undefined,
      anchorDay: Number.isFinite(until) ? new Date(until).getUTCDate() : undefined,
      status: Number.isFinite(until) && until < Date.now() ? 'lapsed' : 'active'
    }
  } catch {
    return undefined
  }
}

/** Renew stored logins once the access token has under two days left. */
const REFRESH_MARGIN_MS = 48 * 3_600_000

/** Milliseconds until the stored access token expires; null when unreadable. */
function accessMsLeft(authJson: string): number | null {
  try {
    const token = (JSON.parse(authJson) as { tokens?: { access_token?: string } }).tokens
      ?.access_token
    const payload = token?.split('.')[1]
    if (!payload) return null
    const exp = (JSON.parse(Buffer.from(payload, 'base64url').toString()) as { exp?: number }).exp
    return typeof exp === 'number' ? exp * 1000 - Date.now() : null
  } catch {
    return null
  }
}

async function refreshAuth(authJson: string): Promise<string | null> {
  const auth = JSON.parse(authJson)
  const refreshToken = auth.tokens?.refresh_token
  if (typeof refreshToken !== 'string') return null
  const res = await fetch(OPENAI_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: OPENAI_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: 'openid profile email'
    })
  }).catch(() => null)
  if (!res?.ok) return null
  const data = (await res.json()) as { access_token?: string; refresh_token?: string; id_token?: string }
  if (!data.access_token) return null
  return JSON.stringify({
    ...auth,
    tokens: {
      ...auth.tokens,
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? refreshToken,
      id_token: data.id_token ?? auth.tokens?.id_token
    },
    last_refresh: new Date().toISOString()
  })
}

function readFirstLine(path: string): string {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(8192)
    const n = readSync(fd, buf, 0, buf.length, 0)
    const text = buf.subarray(0, n).toString('utf8')
    return text.slice(0, text.indexOf('\n') === -1 ? undefined : text.indexOf('\n'))
  } finally {
    closeSync(fd)
  }
}

/** Newest session id recorded for a working directory, from rollout file metadata. */
function latestSessionFor(cwd: string): string | null {
  const root = join(CODEX_DIR, 'sessions')
  if (!existsSync(root)) return null
  const files: { path: string; mtime: number }[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.jsonl')) files.push({ path, mtime: statSync(path).mtimeMs })
    }
  }
  walk(root)
  files.sort((a, b) => b.mtime - a.mtime)
  for (const f of files.slice(0, 30)) {
    try {
      const meta = JSON.parse(readFirstLine(f.path)).payload
      if (meta?.cwd === cwd) return meta.id ?? meta.session_id ?? null
    } catch {
      // not a meta line; skip
    }
  }
  return null
}

export const codex: Adapter = {
  id: 'codex',
  name: 'Codex',
  billingUrl: 'https://chatgpt.com/#settings/Subscription',
  supportsLogin: true,
  targets: [
    { id: 'cli', label: 'Restart terminal sessions' },
    { id: 'desktop', label: 'Codex app' }
  ],

  detect: () => existsSync(CODEX_DIR),

  async liveAccountId() {
    try {
      return identity(readFileSync(AUTH_PATH, 'utf8')).accountId
    } catch {
      return null
    }
  },

  async capture(): Promise<Captured> {
    if (!existsSync(AUTH_PATH)) throw new Error('not signed in. Use Add account')
    const blob = readFileSync(AUTH_PATH, 'utf8')
    return { ...identity(blob), blob }
  },

  async activate(blob: string | null, _extra, on: Set<string>): Promise<string[]> {
    if (blob === null) throw new Error('no saved sign-in for this account')
    const notes: string[] = []
    const desktopInstalled = on.has('desktop') && existsSync(DESKTOP_APP_PATH)
    const wasRunning = desktopInstalled && (await isRunning(DESKTOP_APP).catch(() => false))
    if (wasRunning) await quitApp(DESKTOP_APP)

    // T3's embedded sessions run in ptys: kill them so T3 respawns them itself,
    // and keep them out of the Terminal sweep so they never jump apps.
    // Only kill what a scriptable terminal owns, so it can go back in its own
    // tab. Every other host is left alone; no per-application special cases.
    const candidates = on.has('cli') ? await cliProcesses('codex') : []
    const sessions: typeof candidates = []
    const untouched: typeof candidates = []
    for (const s of candidates) {
      ;(await terminalOwns(s.tty)) ? sessions.push(s) : untouched.push(s)
    }

    if (sessions.length > 0) await killAndWait(sessions.map((s) => s.pid))

    writeFileSync(AUTH_PATH, blob, { mode: 0o600 })

    if (wasRunning) {
      await launchApp(DESKTOP_APP)
      notes.push('Codex app restarted')
    }
    let resumed = 0
    for (const s of sessions) {
      const sessionId = s.cwd ? latestSessionFor(s.cwd) : null
      if (await reopenSession(s, sessionId ? `codex resume ${sessionId}` : 'codex')) resumed++
    }
    if (resumed > 0) notes.push(`resumed ${resumed} codex session${resumed > 1 ? 's' : ''} in place`)
    if (untouched.length > 0) {
      notes.push(
        `${untouched.length} session${untouched.length > 1 ? 's' : ''} left running on the old account — Aliax only restarts sessions in Terminal or iTerm`
      )
    }
    if (sessions.length === 0 && untouched.length === 0 && !wasRunning) {
      notes.push('takes effect for new codex runs')
    }
    return notes
  },

  async usage(blob: string, isActive: boolean, _force?: boolean, mayRefresh = true): Promise<UsageResult> {
    // Resolved up front and attached to every return: the plan lives in the
    // stored token itself, so it should show even when the usage call fails.
    const plan = planFromAuth(blob)
    try {
      const msLeft = accessMsLeft(blob)

      // Saved copies renew themselves before the 10-day access token runs out,
      // so an untouched account stays signed in indefinitely. Never the active
      // account: the CLI owns that file, and a second refresher racing the same
      // rotating token family is exactly what gets a grant revoked.
      if (!isActive && mayRefresh && msLeft !== null && msLeft < REFRESH_MARGIN_MS) {
        const updatedBlob = await refreshAuth(blob)
        if (updatedBlob) {
          const early = await fetchApiUsage(JSON.parse(updatedBlob))
          if (early !== null)
            return { ...early, plan: planFromAuth(updatedBlob) ?? plan, updatedBlob }
        }
      }

      let result = await fetchApiUsage(JSON.parse(blob))
      if (result === null) {
        if (isActive) return { plan, windows: [], note: 'session expired' }
        // A rejected token that has not reached its expiry was revoked, not
        // expired. Refreshing here would present a superseded refresh token,
        // which reads as theft upstream and kills any surviving session too.
        if (msLeft !== null && msLeft > 0)
          return { plan, windows: [], note: 'login revoked. Add the account again' }
        if (!mayRefresh) return { plan, windows: [], note: 'waiting for the gateway owner to refresh' }
        const updatedBlob = await refreshAuth(blob)
        if (!updatedBlob)
          return { plan, windows: [], note: 'session expired. Add the account again' }
        result = await fetchApiUsage(JSON.parse(updatedBlob))
        if (result === null) return { plan, windows: [], note: 'session expired' }
        return { ...result, plan: planFromAuth(updatedBlob) ?? plan, updatedBlob }
      }
      return { ...result, plan }
    } catch (e) {
      const message = (e as Error).message
      if (message === '429') {
        const retry = (e as { retryAfterMs?: number }).retryAfterMs
        return { plan, windows: [], note: 'usage temporarily unavailable', retryAfterMs: retry }
      }
      return { plan, windows: [], note: `usage unavailable (${message})` }
    }
  }
}
