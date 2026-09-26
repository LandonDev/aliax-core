import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { accountIdForToken, liveKeychain } from '../adapters/claude'
import { fetch, role } from '../config'
import { CLAUDE_CLIENT_ID, CLAUDE_TOKEN_URL, OPENAI_CLIENT_ID, OPENAI_TOKEN_URL } from '../oauth'
import { pinProfile, pinnedProfile } from '../settings'
import { hooks } from '../config'
import { cachedReport, observeLimit } from '../accounts'
import { blockedWindow, serviceIdOf, tiersFor } from './failover'
import { classify429, type Limit } from './limits'
import type { ServiceId } from '../shared/types'
import * as vault from '../vault'

/**
 * The forwarding half of the gateway: swap the Authorization header on every
 * CLI request for the account the vault currently pins. Running sessions
 * therefore follow a switch without being killed — the credential is resolved
 * per request rather than read once at startup. The host owns the listening
 * socket; this module only handles one request at a time.
 *
 * Routing: the path's first segment names the service, so one port serves both.
 *   http://127.0.0.1:PORT/claude/...  -> api.anthropic.com
 *   http://127.0.0.1:PORT/codex/...   -> chatgpt.com/backend-api/codex
 */

/**
 * Codex points several subsystems at one configured base but expects them on
 * different upstream roots: model turns answer under `/backend-api/codex`,
 * while the plugin and skill catalogue answers under `/backend-api` (both
 * confirmed against the live API). Resolve per path rather than per service.
 */
export function upstreamFor(service: string, path: string): string | null {
  if (service === 'claude') return 'https://api.anthropic.com'
  if (service !== 'codex') return null
  return path.startsWith('/v1/')
    ? 'https://chatgpt.com/backend-api/codex'
    : 'https://chatgpt.com/backend-api'
}

/**
 * Headers we must not pass upstream: those describing the hop we are
 * terminating, plus the ones the fetch spec reserves for the browser. Chromium
 * rejects the whole request with ERR_INVALID_ARGUMENT if a reserved header is
 * set by hand, and CLIs do send some of them (`sec-fetch-mode`).
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'content-length',
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'cookie',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'origin',
  'referer',
  'via'
])

export const isForbiddenHeader = (name: string): boolean =>
  HOP_BY_HOP.has(name) || name.startsWith('sec-') || name.startsWith('proxy-')

export interface Credential {
  authorization: string
  extraHeaders?: Record<string, string>
}

/** Refresh a minute before expiry, so a long turn cannot start on a dead token. */
const EXPIRY_MARGIN_MS = 60_000

/**
 * One refresh at a time per profile. Rotating refresh tokens invalidate their
 * predecessor, so two concurrent refreshes of the same grant would present the
 * same token twice and get it revoked (invariant 12). Different profiles hold
 * different grants and may refresh side by side.
 */
const refreshing = new Map<string, Promise<void>>()

function once(serviceId: ServiceId, name: string, work: () => Promise<void>): Promise<void> {
  const key = `${serviceId}:${name}`
  const existing = refreshing.get(key)
  if (existing) return existing
  const p = work().finally(() => refreshing.delete(key))
  refreshing.set(key, p)
  return p
}

/** Renew the pinned Claude profile in place when its access token is expiring. */
async function refreshClaudeIfNeeded(name: string, blob: string): Promise<void> {
  let parsed: { keychain?: string; oauthAccount?: unknown }
  try {
    parsed = JSON.parse(blob)
  } catch {
    return
  }
  const tokens = parsed.keychain ? JSON.parse(parsed.keychain)?.claudeAiOauth : null
  const expiresAt = typeof tokens?.expiresAt === 'number' ? tokens.expiresAt : 0
  if (!tokens?.refreshToken || expiresAt - Date.now() > EXPIRY_MARGIN_MS) return

  await once('claude-code', name, async () => {
    const res = await fetch(CLAUDE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: tokens.refreshToken,
        client_id: CLAUDE_CLIENT_ID
      })
    }).catch(() => null)
    if (!res?.ok) return
    const data = (await res.json()) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
    }
    if (!data.access_token) return
    const next = {
      ...tokens,
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? tokens.refreshToken,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000
    }
    const keychain = JSON.stringify({ claudeAiOauth: next })
    vault.saveSecret('claude-code', name, JSON.stringify({ ...parsed, keychain }))
  })
}

/** Same for Codex, whose access token lasts ten days but still expires. */
async function refreshCodexIfNeeded(name: string, raw: string): Promise<void> {
  let auth: { tokens?: { access_token?: string; refresh_token?: string } }
  try {
    auth = JSON.parse(raw)
  } catch {
    return
  }
  const token = auth.tokens?.access_token
  const refreshToken = auth.tokens?.refresh_token
  if (!token || !refreshToken) return
  let exp = 0
  try {
    const payload = token.split('.')[1]
    exp = (JSON.parse(Buffer.from(payload, 'base64url').toString()) as { exp?: number }).exp ?? 0
  } catch {
    return
  }
  if (exp * 1000 - Date.now() > EXPIRY_MARGIN_MS) return

  await once('codex', name, async () => {
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
    if (!res?.ok) return
    const data = (await res.json()) as {
      access_token?: string
      refresh_token?: string
      id_token?: string
    }
    if (!data.access_token) return
    vault.saveSecret(
      'codex',
      name,
      JSON.stringify({
        ...auth,
        tokens: {
          ...auth.tokens,
          access_token: data.access_token,
          refresh_token: data.refresh_token ?? refreshToken,
          id_token: data.id_token ?? (auth.tokens as { id_token?: string })?.id_token
        },
        last_refresh: new Date().toISOString()
      })
    )
  })
}

const bearer = (keychain: string): Credential | null => {
  try {
    const token = JSON.parse(keychain)?.claudeAiOauth?.accessToken
    return typeof token === 'string' ? { authorization: `Bearer ${token}` } : null
  } catch {
    return null
  }
}

const expiryOf = (keychain: string | null): number => {
  if (!keychain) return 0
  try {
    return JSON.parse(keychain)?.claudeAiOauth?.expiresAt ?? 0
  } catch {
    return 0
  }
}

/**
 * Claude's credential for one account: the request's scoped account, else the
 * pinned one.
 *
 * The Keychain copy wins whenever it belongs to the same account, because the
 * CLI refreshes it hourly and our stored snapshot goes stale within the hour.
 * Serving the snapshot then means sending a dead token and, worse, trying to
 * renew it with a refresh token the CLI has already rotated past — which is how
 * a grant gets revoked (invariant 12). Only a pinned account that is NOT the
 * live one is ours to refresh, and only when we are the gateway owner.
 */
async function claudeCredential(account: string | null): Promise<Credential | null> {
  const name = account ?? pinnedProfile('claude-code')
  const live = await liveKeychain()
  if (!name) return live ? bearer(live) : null

  const profile = vault.profiles('claude-code').find((p) => p.name === name)
  let blob = vault.readSecret('claude-code', name)

  if (live && profile) {
    const liveTokens = (() => {
      try {
        return JSON.parse(live)?.claudeAiOauth
      } catch {
        return null
      }
    })()
    const liveId =
      typeof liveTokens?.accessToken === 'string'
        ? await accountIdForToken(liveTokens.accessToken)
        : null
    if (liveId && liveId === profile.accountId) {
      // Same account: adopt the CLI's newer copy so the vault stops drifting.
      let parsed: Record<string, unknown> = {}
      try {
        parsed = blob ? JSON.parse(blob) : {}
      } catch {
        parsed = {}
      }
      if (role() === 'owner' && expiryOf(live) > expiryOf((parsed.keychain as string) ?? null)) {
        vault.saveSecret('claude-code', name, JSON.stringify({ ...parsed, keychain: live }))
      }
      return bearer(live)
    }
  }

  // A different account than the CLI holds: our copy is the only one, so it is
  // ours to keep fresh.
  if (blob) {
    if (role() === 'owner') await refreshClaudeIfNeeded(name, blob).catch(() => {})
    blob = vault.readSecret('claude-code', name) ?? blob
    try {
      const keychain = JSON.parse(blob).keychain
      if (keychain && expiryOf(keychain) > Date.now()) return bearer(keychain)
    } catch {
      // fall through to the explicit failure below
    }
  }
  // Never send a token we know is dead: a clear 503 beats a confusing OAuth error.
  return null
}

/** Codex: the account's (else the pinned profile's) auth.json, falling back to the live file. */
async function codexCredential(account: string | null): Promise<Credential | null> {
  const name = account ?? pinnedProfile('codex')
  let raw = name ? vault.readSecret('codex', name) : null
  if (name && raw) {
    if (role() === 'owner') await refreshCodexIfNeeded(name, raw).catch(() => {})
    raw = vault.readSecret('codex', name) ?? raw
  }
  if (!raw) {
    try {
      raw = readFileSync(join(homedir(), '.codex', 'auth.json'), 'utf8')
    } catch {
      return null
    }
  }
  try {
    const tokens = JSON.parse(raw).tokens ?? {}
    if (typeof tokens.access_token !== 'string') return null
    const extraHeaders: Record<string, string> = {}
    if (typeof tokens.account_id === 'string') extraHeaders['chatgpt-account-id'] = tokens.account_id
    return { authorization: `Bearer ${tokens.access_token}`, extraHeaders }
  } catch {
    return null
  }
}

/** The credential to send for `service`, under `account` when a request names one. */
export const credentialFor = (service: string, account: string | null = null): Promise<Credential | null> =>
  service === 'claude' ? claudeCredential(account) : codexCredential(account)

export function fail(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.end()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { type: 'aliax_proxy', message } }))
}

/** Collect the body up front: we must be able to replay it on a retry. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * A scope segment names the thread a request belongs to and the account it
 * should spend from, so one gateway can serve many threads on many accounts:
 *   /claude/~t=<thread>;a=<account>[;pin=1]/v1/messages
 * `pin=1` says the account is an explicit pin (thread, project or workspace)
 * rather than an automatic pick; a pinned thread returns to its pin once that
 * account has room again, an automatic one stays where failover left it.
 */
export interface RouteScope {
  thread: string
  account: string
  pin: boolean
}

/** Parse one `~t=…;a=…` path segment; null when it is not a scope. */
export function parseScope(segment: string): RouteScope | null {
  if (!segment.startsWith('~')) return null
  const fields: Record<string, string> = {}
  for (const part of segment.slice(1).split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    try {
      fields[part.slice(0, eq)] = decodeURIComponent(part.slice(eq + 1))
    } catch {
      return null
    }
  }
  if (!fields.t || !fields.a) return null
  return { thread: fields.t, account: fields.a, pin: fields.pin === '1' }
}

/** Split `/codex/~t=T;a=A/v1/responses` into its service, scope and upstream path. */
export function splitPath(url: string): { service: string; rest: string; scope: RouteScope | null } {
  const slash = url.indexOf('/', 1)
  const service = url.slice(1, slash === -1 ? undefined : slash)
  let rest = slash === -1 ? '' : url.slice(slash)
  let scope: RouteScope | null = null
  if (rest.startsWith('/~')) {
    const end = rest.indexOf('/', 1)
    scope = parseScope(rest.slice(1, end === -1 ? undefined : end))
    if (scope) rest = end === -1 ? '' : rest.slice(end)
  }
  // Codex builds its connector-runtime URL as <base>/api/codex/ps/mcp when
  // the base (us) has no /backend-api marker — strip the doubled prefix so
  // /ps/* resolves against the real codex backend.
  if (service === 'codex' && rest.startsWith('/api/codex/')) rest = rest.slice('/api/codex'.length)
  return { service, rest, scope }
}

/**
 * Where each scoped thread routes when failover moved it off the account its
 * URL names. Owner memory only: an owner restart forgets the overrides, and the
 * pre-emptive pick on the thread's next request derives them again from the
 * usage cache.
 */
const routes = new Map<string, string>()

/** The account a thread currently routes to, when failover moved it. */
export const routeOf = (thread: string): string | undefined => routes.get(thread)

/** Test seam: forget every per-thread override. */
export const clearRoutes = (): void => routes.clear()

export interface LimitInfo {
  service: string
  serviceId: ServiceId
  /** The request body's `model`, when it had one. */
  model: string | null
  limit: Limit
  /** Accounts this request has already exhausted, the one it spent from included. */
  tried: string[]
  /** The account that hit the limit (the thread's current one, or the pin). */
  account: string
  /** Set for a scoped request: the pick is for this thread alone. */
  thread?: string
}

export interface RoutedInfo {
  service: string
  serviceId: ServiceId
  thread: string
  /** The account the thread routes to from now on. */
  account: string
}

export interface ForwardHooks {
  /** Every upstream answer, before its body streams back. A 429 carries its body text. */
  onResponse?: (info: {
    service: string
    path: string
    status: number
    headers: Headers
    body?: string
    /** The account the answer came from. */
    account: string | null
  }) => void
  onError?: (message: string) => void
  /**
   * An account hit a real limit: name another account with room and the
   * request replays under it, or return null to pass the 429 through. For an
   * unscoped request the gateway pins the name it gets back; for a scoped one
   * only that thread moves.
   */
  pickNext?: (info: LimitInfo) => Promise<string | null>
  /** The first answer that got through after an unscoped switch; the host activates `to` now. */
  onFailedOver?: (info: { service: string; serviceId: ServiceId; from: string; to: string }) => void
  /** A scoped thread routes to a different account from now on (override set or dropped). */
  onRouted?: (info: RoutedInfo) => void
}

/** Replays per request: past this the 429 goes to the client as it came. */
export const MAX_REPLAYS = 3

const modelOf = (body: Buffer | undefined): string | null => {
  if (!body || body.length === 0) return null
  try {
    const model = JSON.parse(body.toString('utf8'))?.model
    return typeof model === 'string' ? model : null
  } catch {
    return null
  }
}

export interface ForwardOutcome {
  service: string
  status: number | null
}

/**
 * Forward one request and stream the answer back: under the thread's account
 * when the path carries a scope, else under the pinned one. Returns the
 * upstream status, or null when nothing reached upstream.
 */
export async function forward(
  req: IncomingMessage,
  res: ServerResponse,
  on: ForwardHooks = {}
): Promise<ForwardOutcome> {
  const { service, rest, scope } = splitPath(req.url ?? '/')
  const upstream = upstreamFor(service, rest)
  if (!upstream) {
    fail(res, 404, `unknown service "${service}"`)
    return { service, status: null }
  }

  const body = ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : await readBody(req)
  const serviceId = serviceIdOf(service)
  const model = modelOf(body)
  const tried: string[] = []
  let switchedFrom: string | null = null
  let upstreamRes: Response
  let rejected: string | undefined

  // A scoped request spends from the thread's account: the one its URL names,
  // unless failover moved the thread. Both are checked against the cache
  // before anything goes out, so a thread never sends a request it is known
  // to lose.
  let target: string | null = null
  if (scope && serviceId) {
    const now = Date.now()
    const tiers = tiersFor(serviceId, model)
    target = routes.get(scope.thread) ?? scope.account
    const route = (account: string): void => {
      if (account === scope.account) routes.delete(scope.thread)
      else routes.set(scope.thread, account)
      target = account
      on.onRouted?.({ service, serviceId, thread: scope.thread, account })
    }
    // A pinned thread goes back to its pin as soon as the pin has room again.
    if (scope.pin && target !== scope.account && !blockedWindow(cachedReport(serviceId, scope.account), tiers, now)) {
      route(scope.account)
    }
    const blocked = on.pickNext ? blockedWindow(cachedReport(serviceId, target), tiers, now) : null
    if (blocked) {
      const next = await on
        .pickNext!({ service, serviceId, model, limit: blocked, tried: [target], account: target, thread: scope.thread })
        .catch(() => null)
      if (next && next !== target) route(next)
    }
  }

  // The replay loop: a real limit moves the request to another account (when
  // the host names one) and sends the same bytes again. Bounded, and never for
  // a transient 429, which the CLI retries itself.
  for (;;) {
    if (target && serviceId && !vault.profiles(serviceId).some((p) => p.name === target)) {
      fail(res, 503, `Aliax has no saved account "${target}" for ${service}. Add it in Aliax or pick another account.`)
      return { service, status: null }
    }
    const account = target ?? (serviceId ? pinnedProfile(serviceId) : null)
    const credential = await credentialFor(service, target)
    if (!credential) {
      fail(
        res,
        503,
        `Aliax has no usable sign-in for ${service}. Open Aliax and switch to an account, or sign in again.`
      )
      return { service, status: null }
    }

    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (isForbiddenHeader(k.toLowerCase()) || v === undefined) continue
      headers[k] = Array.isArray(v) ? v.join(', ') : v
    }
    headers['authorization'] = credential.authorization
    // The CLI may send its own account scoping; ours must win.
    delete headers['x-api-key']
    for (const [k, v] of Object.entries(credential.extraHeaders ?? {})) headers[k] = v

    try {
      upstreamRes = await fetch(`${upstream}${rest}`, {
        method: req.method,
        headers,
        // A plain byte body, never a stream: `duplex` is rejected here, and the
        // buffered form is what lets a retry replay the same request.
        body: body && body.length > 0 ? new Uint8Array(body) : undefined
      })
    } catch (e) {
      const message = (e as Error).message
      on.onError?.(message)
      fail(res, 502, `Aliax could not reach ${service}: ${message}`)
      return { service, status: null }
    }

    // A limit answer is small and worth keeping whole: the hook logs it for the
    // failover fixtures, and the client still gets every byte.
    rejected = upstreamRes.status === 429 ? await upstreamRes.text().catch(() => '') : undefined
    on.onResponse?.({ service, path: rest, status: upstreamRes.status, headers: upstreamRes.headers, body: rejected, account })

    if (rejected === undefined || !serviceId || !on.pickNext || !account) break
    const limit = classify429(service, upstreamRes.headers, rejected)
    if (limit.window === 'transient') break
    observeLimit(serviceId, account, limit)
    if (tried.length >= MAX_REPLAYS) break
    tried.push(account)
    const next = await on
      .pickNext({ service, serviceId, model, limit, tried: [...tried], account, thread: scope?.thread })
      .catch(() => null)
    if (!next || next === account || tried.includes(next)) break
    if (scope) {
      // Only this thread moves; the pin is the terminal CLIs' business.
      if (next === scope.account) routes.delete(scope.thread)
      else routes.set(scope.thread, next)
      target = next
      on.onRouted?.({ service, serviceId, thread: scope.thread, account: next })
      continue
    }
    // Sticky by design: the pin moves only here or on a user's click, never on success.
    pinProfile(serviceId, next)
    switchedFrom ??= account
    hooks().onAccountsChanged?.()
  }
  if (switchedFrom && serviceId && upstreamRes.status < 400) {
    on.onFailedOver?.({ service, serviceId, from: switchedFrom, to: pinnedProfile(serviceId) ?? '' })
  }

  const outHeaders: Record<string, string> = {}
  upstreamRes.headers.forEach((value, key) => {
    const name = key.toLowerCase()
    // The host's fetch hands us decoded bytes, so passing the upstream's encoding or
    // length through would make the client try to decompress plaintext.
    if (name === 'content-encoding' || name === 'content-length') return
    if (isForbiddenHeader(name)) return
    outHeaders[key] = value
  })
  res.writeHead(upstreamRes.status, outHeaders)

  if (rejected !== undefined) {
    res.end(rejected)
    return { service, status: upstreamRes.status }
  }
  if (!upstreamRes.body) {
    res.end()
    return { service, status: upstreamRes.status }
  }
  const reader = upstreamRes.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      // Respect backpressure so a slow terminal cannot balloon memory.
      if (!res.write(Buffer.from(value))) {
        await new Promise((resolve) => res.once('drain', resolve))
      }
    }
  } catch (e) {
    on.onError?.((e as Error).message)
  } finally {
    res.end()
  }
  return { service, status: upstreamRes.status }
}
