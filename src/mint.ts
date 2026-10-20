import { fetch } from './config'
import { withLock } from './lock'
import { CLAUDE_CLIENT_ID, CLAUDE_TOKEN_URL, INFERENCE_ONLY_SCOPES, ONE_YEAR_S, STATIC_SCOPES } from './oauth'
import type { StaticClaudeToken } from './sync'
import { hasRefresh, ownsProfile, profileOf, saveStaticClaude } from './sync'
import * as vault from './vault'

/**
 * One-year Claude tokens, the bearers `claude setup-token` makes, minted
 * here instead of in the CLI's browser. What the CLI does (2.1.301): the
 * ordinary authorization-code exchange, plus `expires_in: 31536000` in the
 * token-exchange body; nothing in the authorize URL differs but the scope.
 * The same field rides a refresh_token grant, which is how `claude auth
 * login` with CLAUDE_CODE_OAUTH_REFRESH_TOKEN mints one with no browser.
 *
 * Both grants answer with `account` (uuid, email_address) and
 * `organization`, so a minted token names its own account whatever its
 * scope: a token is filed only under the account the server says it is
 * for, never under the row the mint started from.
 */

export const ONE_YEAR_MS = ONE_YEAR_S * 1000
/** A mint that lands shorter than this did not get the year: the server ignored or capped `expires_in`. */
export const STATIC_MIN_LIFETIME_MS = 300 * 86_400_000
/** Renew a static token this long before it lapses. */
export const STATIC_RENEW_WINDOW_MS = 30 * 86_400_000

export interface MintedToken {
  accessToken: string
  /** The rotated grant a refresh_token mint answers with; null from a code exchange made for a static token. */
  refreshToken: string | null
  expiresAt: number
  expiresInS: number
  scopes: string[]
  account: { uuid: string; email?: string } | null
  organization: { uuid?: string; name?: string } | null
}

/** The token endpoint's JSON as a MintedToken, or null when it names no usable token. */
export function parseTokenResponse(data: unknown, now = Date.now()): MintedToken | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (typeof d.access_token !== 'string' || !d.access_token) return null
  if (typeof d.expires_in !== 'number' || !Number.isFinite(d.expires_in)) return null
  const account = d.account as { uuid?: unknown; email_address?: unknown; email?: unknown } | undefined
  const org = d.organization as { uuid?: unknown; name?: unknown } | undefined
  const email = typeof account?.email_address === 'string' ? account.email_address : typeof account?.email === 'string' ? account.email : undefined
  return {
    accessToken: d.access_token,
    refreshToken: typeof d.refresh_token === 'string' && d.refresh_token ? d.refresh_token : null,
    expiresAt: now + d.expires_in * 1000,
    expiresInS: d.expires_in,
    scopes: typeof d.scope === 'string' ? d.scope.split(/\s+/).filter(Boolean) : [],
    account: typeof account?.uuid === 'string' ? { uuid: account.uuid, email } : null,
    organization: org && (typeof org.uuid === 'string' || typeof org.name === 'string') ? { uuid: typeof org.uuid === 'string' ? org.uuid : undefined, name: typeof org.name === 'string' ? org.name : undefined } : null
  }
}

export type MintRefusal = 'short-lived' | 'wrong-account' | 'no-account'
export type MintCheck = { ok: true } | { ok: false; reason: MintRefusal; detail: string }

/**
 * Is this token the one-year token for `expected`? The year is the response's
 * own `expires_in`; the account is the response's `account`, matched by id
 * (then by email when the row only ever had an email). A response that names
 * no account is refused unless `allowUnnamed` says the caller proved the
 * identity another way (the claude.ai session the mint ran in).
 */
export function checkMinted(
  m: MintedToken,
  expected: { accountId?: string; email?: string },
  opts: { now?: number; allowUnnamed?: boolean } = {}
): MintCheck {
  const now = opts.now ?? Date.now()
  if (m.expiresAt - now < STATIC_MIN_LIFETIME_MS) {
    return { ok: false, reason: 'short-lived', detail: `the token lasts ${Math.round((m.expiresAt - now) / 3_600_000)} h, not a year` }
  }
  if (!m.account) return opts.allowUnnamed ? { ok: true } : { ok: false, reason: 'no-account', detail: 'the token response named no account' }
  const sameId = !!expected.accountId && m.account.uuid === expected.accountId
  const sameEmail = !!expected.email && !!m.account.email && m.account.email.toLowerCase() === expected.email.toLowerCase()
  // An email placeholder id (a row made from a typed address) counts as the email.
  const idIsEmail = !!expected.accountId && expected.accountId.includes('@') && !!m.account.email && expected.accountId.toLowerCase() === m.account.email.toLowerCase()
  if (sameId || idIsEmail || (!expected.accountId && sameEmail)) return { ok: true }
  return {
    ok: false,
    reason: 'wrong-account',
    detail: `the token belongs to ${m.account.email ?? m.account.uuid}, not ${expected.email ?? expected.accountId ?? 'this account'}`
  }
}

/** The static profile a verified mint becomes; the row's identity comes from the response first. */
export function staticTokenOf(m: MintedToken, fallback: { accountId?: string; email?: string }): StaticClaudeToken {
  const accountId = m.account?.uuid ?? fallback.accountId ?? fallback.email
  if (!accountId) throw new Error('no account to file the token under')
  return {
    token: m.accessToken,
    expiresAt: m.expiresAt,
    accountId,
    email: m.account?.email ?? fallback.email,
    scopes: m.scopes.length ? m.scopes : undefined,
    organizationUuid: m.organization?.uuid,
    organizationName: m.organization?.name
  }
}

export class TokenEndpointError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | null,
    detail: string
  ) {
    super(detail)
  }
}

async function postToken(body: Record<string, unknown>, now: () => number): Promise<MintedToken> {
  const res = await fetch(CLAUDE_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!res.ok) {
    const code = typeof data?.error === 'string' ? data.error : null
    const text = typeof data?.error_description === 'string' ? data.error_description : code
    throw new TokenEndpointError(res.status, code, `token endpoint answered ${res.status}${text ? ` (${text})` : ''}`)
  }
  const minted = parseTokenResponse(data, now())
  if (!minted) throw new TokenEndpointError(res.status, null, 'token endpoint answered without a token')
  return minted
}

/**
 * The code half of a browser sign-in exchanged for a one-year token: the
 * ordinary authorization_code body plus `expires_in`. The caller checks and
 * files what comes back (checkMinted, staticTokenOf, saveStaticClaude).
 */
export async function exchangeCodeForStatic(
  input: { code: string; state: string; verifier: string; redirectUri: string },
  opts: { expiresInS?: number; now?: () => number } = {}
): Promise<MintedToken> {
  return postToken(
    {
      grant_type: 'authorization_code',
      code: input.code,
      state: input.state,
      client_id: CLAUDE_CLIENT_ID,
      redirect_uri: input.redirectUri,
      code_verifier: input.verifier,
      expires_in: opts.expiresInS ?? ONE_YEAR_S
    },
    opts.now ?? Date.now
  )
}

export type RefreshMintOutcome =
  | { ok: true; name: string; minted: Pick<MintedToken, 'expiresAt' | 'scopes' | 'account'> }
  | {
      ok: false
      /** `no-grant`: nothing here to present (not ours, or no refresh token); `endpoint`: the token endpoint refused; else checkMinted's word. */
      reason: 'no-grant' | 'endpoint' | MintRefusal
      detail: string
    }

type ClaudeTokens = { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown; scopes?: unknown }

function parseClaude(blob: string): { parsed: Record<string, unknown>; tokens: ClaudeTokens } {
  try {
    const parsed = JSON.parse(blob) as Record<string, unknown>
    const tokens = typeof parsed.keychain === 'string' ? (JSON.parse(parsed.keychain)?.claudeAiOauth ?? {}) : {}
    return { parsed, tokens }
  } catch {
    return { parsed: {}, tokens: {} }
  }
}

/**
 * Mint a one-year token for a Claude account from the refresh grant this
 * host holds for it, with no browser and no session: a refresh_token grant
 * with `expires_in: 31536000`. Under the profile's lock, so no refresh or
 * handoff interleaves. The grant rotates on every call, so the rotated
 * refresh token is saved before anything is judged: a mint that is refused
 * leaves the account as a healthy owned profile, never without its grant.
 *
 * `user:profile user:inference` is asked for first (the token can then name
 * its account and read usage); should the server grant that pair only a
 * short life, `user:inference` alone is tried, the way the CLI asks. A
 * verified year is filed through saveStaticClaude, which writes the static
 * blob without a refresh token: that is the grant being dropped, and only
 * then. A profile whose issued scopes never included `user:profile` asks
 * for `user:inference` alone from the start.
 */
export async function mintStaticFromRefresh(
  name: string,
  opts: { scopeSets?: string[][]; now?: () => number } = {}
): Promise<RefreshMintOutcome> {
  const now = opts.now ?? Date.now
  return withLock('claude-code', name, async (): Promise<RefreshMintOutcome> => {
    const profile = profileOf('claude-code', name)
    if (!profile) return { ok: false, reason: 'no-grant', detail: `no account named ${name}` }
    let stored: string | null
    try {
      stored = vault.readSecret('claude-code', name)
    } catch {
      stored = null
    }
    if (!stored || !ownsProfile(profile) || !hasRefresh('claude-code', stored)) {
      return { ok: false, reason: 'no-grant', detail: profile.static ? 'a one-year token holds no grant to mint from' : ownsProfile(profile) ? 'no refresh token on file' : `the grant is refreshed by ${profile.owner}` }
    }
    const issued = Array.isArray(parseClaude(stored).tokens.scopes) ? (parseClaude(stored).tokens.scopes as unknown[]).filter((s): s is string => typeof s === 'string') : null
    const scopeSets = opts.scopeSets ?? (issued && !issued.includes('user:profile') ? [INFERENCE_ONLY_SCOPES] : [STATIC_SCOPES, INFERENCE_ONLY_SCOPES])
    let last: RefreshMintOutcome = { ok: false, reason: 'endpoint', detail: 'nothing was asked' }
    for (const scopes of scopeSets) {
      const current = vault.readSecret('claude-code', name)
      if (!current) return { ok: false, reason: 'no-grant', detail: 'the account vanished mid-mint' }
      const { parsed, tokens } = parseClaude(current)
      if (typeof tokens.refreshToken !== 'string') return { ok: false, reason: 'no-grant', detail: 'no refresh token on file' }
      let minted: MintedToken
      try {
        minted = await postToken(
          { grant_type: 'refresh_token', refresh_token: tokens.refreshToken, client_id: CLAUDE_CLIENT_ID, scope: scopes.join(' '), expires_in: ONE_YEAR_S },
          now
        )
      } catch (err) {
        const e = err as TokenEndpointError
        // A scope the grant never had: ask for less. Anything else ends the attempt with the grant as it was.
        if (e.code === 'invalid_scope' && scopes !== scopeSets[scopeSets.length - 1]) {
          last = { ok: false, reason: 'endpoint', detail: e.message }
          continue
        }
        return { ok: false, reason: 'endpoint', detail: e.message ?? String(err) }
      }
      // The grant rotated: keep it before judging the token, so a refusal costs nothing.
      const rotated = {
        ...tokens,
        accessToken: minted.accessToken,
        refreshToken: minted.refreshToken ?? tokens.refreshToken,
        expiresAt: minted.expiresAt
      }
      vault.saveSecret('claude-code', name, JSON.stringify({ ...parsed, keychain: JSON.stringify({ claudeAiOauth: rotated }) }))
      const check = checkMinted(minted, { accountId: profile.accountId, email: profile.email }, { now: now() })
      if (check.ok) {
        const filed = saveStaticClaude(staticTokenOf(minted, { accountId: profile.accountId, email: profile.email }))
        return { ok: true, name: filed, minted: { expiresAt: minted.expiresAt, scopes: minted.scopes, account: minted.account } }
      }
      last = { ok: false, reason: check.reason, detail: check.detail }
      if (check.reason !== 'short-lived') return last
    }
    return last
  })
}

/** Is a static token inside its renewal window (or past it)? */
export const staticRenewalDue = (expiresAt: number | undefined, now = Date.now()): boolean =>
  expiresAt !== undefined && expiresAt - now <= STATIC_RENEW_WINDOW_MS
