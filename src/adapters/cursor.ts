import { fetch } from '../config'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { PlanInfo, UsageWindow } from '../shared/types'
import { isRunning, launchApp, quitApp } from '../apps'
import { readPassword, writePassword } from '../keychain'
import type { Adapter, Captured, UsageResult } from './types'
import { decodeJwtPayload, retryAfterMs } from './types'

const APP = 'Cursor'
const KEYCHAIN_ACCOUNT = 'cursor-user'
const ACCESS_SERVICE = 'cursor-access-token'
const REFRESH_SERVICE = 'cursor-refresh-token'
const VSCDB = join(homedir(), 'Library/Application Support/Cursor/User/globalStorage/state.vscdb')

function readVscdbAuth(): Record<string, string> {
  const db = new DatabaseSync(VSCDB, { readOnly: true })
  try {
    const rows = db
      .prepare("SELECT key, value FROM ItemTable WHERE key LIKE 'cursorAuth/%'")
      .all() as { key: string; value: string }[]
    return Object.fromEntries(rows.map((r) => [r.key, r.value]))
  } finally {
    db.close()
  }
}

function writeVscdbAuth(entries: Record<string, string>): void {
  const db = new DatabaseSync(VSCDB)
  try {
    const stmt = db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)')
    for (const [key, value] of Object.entries(entries)) stmt.run(key, value)
  } finally {
    db.close()
  }
}

function jwtSub(token: string): string | null {
  try {
    const sub = decodeJwtPayload(token).sub
    return typeof sub === 'string' ? sub : null
  } catch {
    return null
  }
}

function sessionCookie(sub: string, access: string): string {
  return `WorkosCursorSessionToken=${encodeURIComponent(`${sub}::${access}`)}`
}

const CURSOR_PLANS: Record<string, { name: string; monthlyUsd?: number }> = {
  free: { name: 'Free', monthlyUsd: 0 },
  pro: { name: 'Pro', monthlyUsd: 20 },
  'pro-plus': { name: 'Pro+', monthlyUsd: 60 },
  ultra: { name: 'Ultra', monthlyUsd: 200 },
  team: { name: 'Team' },
  enterprise: { name: 'Enterprise' }
}

async function fetchPlan(
  sub: string,
  access: string,
  renewsAt?: number
): Promise<PlanInfo | undefined> {
  const res = await fetch('https://cursor.com/api/auth/stripe', { headers: { Cookie: sessionCookie(sub, access) } })
    .catch(() => null)
  if (!res?.ok) return undefined
  const data = (await res.json()) as {
    membershipType?: string
    subscriptionStatus?: string
    /** Set when the user cancelled but the paid period has not ended yet. */
    pendingCancellationDate?: string | number | null
  }
  if (!data.membershipType) return undefined
  const tier = CURSOR_PLANS[data.membershipType] ?? {
    name: data.membershipType.charAt(0).toUpperCase() + data.membershipType.slice(1)
  }
  const pending = data.pendingCancellationDate
  const cancelsAt =
    typeof pending === 'number' ? pending : typeof pending === 'string' ? Date.parse(pending) : NaN
  const cancelled = Number.isFinite(cancelsAt)
  return {
    name: tier.name,
    monthlyUsd: tier.monthlyUsd,
    // A cancelled subscription has an end date, not a renewal.
    renewsAt: cancelled ? undefined : renewsAt,
    anchorDay: cancelled || renewsAt === undefined ? undefined : new Date(renewsAt).getUTCDate(),
    cancelsAt: cancelled ? cancelsAt : undefined,
    status: data.subscriptionStatus
  }
}

export const cursor: Adapter = {
  id: 'cursor',
  name: 'Cursor',
  billingUrl: 'https://cursor.com/dashboard?tab=billing',
  supportsLogin: true,
  targets: [{ id: 'app', label: 'Restart Cursor' }],

  detect: () => existsSync(VSCDB),

  async liveAccountId() {
    try {
      const token = readVscdbAuth()['cursorAuth/accessToken']
      return token ? jwtSub(token) : null
    } catch {
      return null
    }
  },

  async capture(): Promise<Captured> {
    const access = await readPassword(ACCESS_SERVICE)
    const refresh = await readPassword(REFRESH_SERVICE)
    const vscdb = readVscdbAuth()
    const accountId = jwtSub(access)
    if (!accountId) throw new Error('could not read account id from access token')
    return {
      accountId,
      email: vscdb['cursorAuth/cachedEmail'],
      blob: JSON.stringify({ access, refresh, vscdb })
    }
  },

  async activate(blob: string | null, _extra, on: Set<string>): Promise<string[]> {
    if (blob === null) throw new Error('no saved sign-in for this account')
    const { access, refresh, vscdb } = JSON.parse(blob)
    const notes: string[] = []
    const restartApp = on.has('app')
    const wasRunning = await isRunning(APP)
    if (restartApp && wasRunning) await quitApp(APP)

    await writePassword(ACCESS_SERVICE, KEYCHAIN_ACCOUNT, access)
    await writePassword(REFRESH_SERVICE, KEYCHAIN_ACCOUNT, refresh)
    writeVscdbAuth(vscdb)

    if (restartApp && wasRunning) {
      await launchApp(APP)
      notes.push('Cursor restarted')
    } else if (wasRunning) {
      notes.push('restart Cursor to apply')
    }
    return notes
  },

  async usage(blob: string): Promise<UsageResult> {
    const { access } = JSON.parse(blob)
    const sub = jwtSub(access)
    if (!sub) return { windows: [], note: 'no token saved' }

    // The meters Cursor's own Plan & Usage screen draws ("Cursor Models 69%
    // used") come from the IDE's RPC backend, not the web API — the web
    // dashboard's /api/usage is the retired request-quota shape and returns
    // nulls on current plans. Same access token, plain JSON ConnectRPC.
    const res = await fetch(
      'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
        body: '{}'
      }
    )
    if (res.status === 401 || res.status === 403) {
      return { windows: [], note: 'session expired. Switch to it once to refresh' }
    }
    if (res.status === 429)
      return { windows: [], note: 'usage temporarily unavailable', retryAfterMs: retryAfterMs(res) }
    if (!res.ok) return { windows: [], note: `usage unavailable (${res.status})` }

    const data = (await res.json()) as {
      billingCycleStart?: string | number
      billingCycleEnd?: string | number
      planUsage?: { autoPercentUsed?: number; apiPercentUsed?: number }
      spendLimitUsage?: { individualLimit?: number; individualUsed?: number }
    }
    const start = Number(data.billingCycleStart)
    const end = Number(data.billingCycleEnd)
    const resetsAt = Number.isFinite(end) && end > 0 ? end : undefined
    const periodMs = resetsAt !== undefined && Number.isFinite(start) && start > 0 ? end - start : undefined

    const windows: UsageWindow[] = []
    if (typeof data.planUsage?.autoPercentUsed === 'number')
      windows.push({ label: 'Cursor models', usedPercent: data.planUsage.autoPercentUsed, resetsAt, periodMs })
    if (typeof data.planUsage?.apiPercentUsed === 'number')
      windows.push({ label: 'other models', usedPercent: data.planUsage.apiPercentUsed, resetsAt, periodMs })

    // On-demand is a spend cap in cents, not a rate window; a short fact reads
    // better than a third bar that sits at 0% for most people.
    const capCents = data.spendLimitUsage?.individualLimit ?? 0
    const usedCents = data.spendLimitUsage?.individualUsed ?? 0
    const dollars = (c: number): string => `$${(c / 100).toFixed(c % 100 === 0 ? 0 : 2)}`
    const extra = capCents > 0 ? `on-demand ${dollars(usedCents)} of ${dollars(capCents)}` : undefined

    const plan = await fetchPlan(sub, access, resetsAt)

    if (windows.length > 0) return { windows, extra, plan }

    // Accounts still on the old request-quota plans keep their old meters.
    const legacy = await legacyWindows(sub, access)
    return legacy.length > 0
      ? { windows: legacy, plan }
      : { windows: [], note: 'no usage caps on this plan', extra, plan }
  }
}

/** The pre-2026 per-model request quotas; empty on current plans. */
async function legacyWindows(sub: string, access: string): Promise<UsageWindow[]> {
  const res = await fetch(`https://cursor.com/api/usage?user=${encodeURIComponent(sub)}`, {
      headers: { Cookie: sessionCookie(sub, access) }
    })
    .catch(() => null)
  if (!res?.ok) return []
  const data = (await res.json()) as Record<string, unknown>
  const windows: UsageWindow[] = []
  const monthStart = typeof data.startOfMonth === 'string' ? Date.parse(data.startOfMonth) : NaN
  const resetsAt = Number.isNaN(monthStart)
    ? undefined
    : new Date(monthStart).setMonth(new Date(monthStart).getMonth() + 1)
  for (const [key, value] of Object.entries(data)) {
    if (!value || typeof value !== 'object') continue
    const { numRequests, maxRequestUsage } = value as { numRequests?: unknown; maxRequestUsage?: unknown }
    if (typeof numRequests !== 'number' || typeof maxRequestUsage !== 'number' || !maxRequestUsage)
      continue
    windows.push({
      label: key === 'gpt-4' ? 'requests' : key,
      usedPercent: (numRequests / maxRequestUsage) * 100,
      resetsAt
    })
  }
  return windows
}
