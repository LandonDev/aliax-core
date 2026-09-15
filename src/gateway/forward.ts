import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { accountIdForToken, liveKeychain } from '../adapters/claude'
import { fetch, role } from '../config'
import { CLAUDE_CLIENT_ID, CLAUDE_TOKEN_URL, OPENAI_CLIENT_ID, OPENAI_TOKEN_URL } from '../oauth'
import { pinnedProfile } from '../settings'
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
 * One refresh at a time per service. Rotating refresh tokens invalidate their
 * predecessor, so two concurrent refreshes would present the same token twice
 * and get the whole grant revoked (invariant 12).
 */
const refreshing = new Map<ServiceId, Promise<void>>()

function once(serviceId: ServiceId, work: () => Promise<void>): Promise<void> {
  const existing = refreshing.get(serviceId)
  if (existing) return existing
  const p = work().finally(() => refreshing.delete(serviceId))
  refreshing.set(serviceId, p)
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

  await once('claude-code', async () => {
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

  await once('codex', async () => {
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
 * Claude's credential for the pinned account.
 *
 * The Keychain copy wins whenever it belongs to the same account, because the
 * CLI refreshes it hourly and our stored snapshot goes stale within the hour.
 * Serving the snapshot then means sending a dead token and, worse, trying to
 * renew it with a refresh token the CLI has already rotated past — which is how
 * a grant gets revoked (invariant 12). Only a pinned account that is NOT the
 * live one is ours to refresh, and only when we are the gateway owner.
 */
async function claudeCredential(): Promise<Credential | null> {
  const name = pinnedProfile('claude-code')
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

/** Codex: the pinned profile's auth.json, falling back to the live file. */
async function codexCredential(): Promise<Credential | null> {
  const name = pinnedProfile('codex')
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

export const credentialFor = (service: string): Promise<Credential | null> =>
  service === 'claude' ? claudeCredential() : codexCredential()

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

/** Split `/codex/v1/responses` into its service and upstream path. */
export function splitPath(url: string): { service: string; rest: string } {
  const slash = url.indexOf('/', 1)
  const service = url.slice(1, slash === -1 ? undefined : slash)
  let rest = slash === -1 ? '' : url.slice(slash)
  // Codex builds its connector-runtime URL as <base>/api/codex/ps/mcp when
  // the base (us) has no /backend-api marker — strip the doubled prefix so
  // /ps/* resolves against the real codex backend.
  if (service === 'codex' && rest.startsWith('/api/codex/')) rest = rest.slice('/api/codex'.length)
  return { service, rest }
}

export interface ForwardHooks {
  /** Every upstream answer, before its body streams back. A 429 carries its body text. */
  onResponse?: (info: { service: string; path: string; status: number; headers: Headers; body?: string }) => void
  onError?: (message: string) => void
}

export interface ForwardOutcome {
  service: string
  status: number | null
}

/**
 * Forward one request under the pinned account and stream the answer back.
 * Returns the upstream status, or null when nothing reached upstream.
 */
export async function forward(
  req: IncomingMessage,
  res: ServerResponse,
  on: ForwardHooks = {}
): Promise<ForwardOutcome> {
  const { service, rest } = splitPath(req.url ?? '/')
  const upstream = upstreamFor(service, rest)
  if (!upstream) {
    fail(res, 404, `unknown service "${service}"`)
    return { service, status: null }
  }

  const credential = await credentialFor(service)
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

  const body = ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : await readBody(req)

  let upstreamRes: Response
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
  const rejected = upstreamRes.status === 429 ? await upstreamRes.text().catch(() => '') : undefined
  on.onResponse?.({ service, path: rest, status: upstreamRes.status, headers: upstreamRes.headers, body: rejected })

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
