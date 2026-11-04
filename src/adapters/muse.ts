import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Adapter, Captured, UsageResult } from './types'

/**
 * Muse Code (Meta's coding CLI, `muse`): the subscription login the CLI
 * keeps in `auth.json` under its config root. The file is static: a
 * device-code `access_token`, the `api_key` the login minted (what the CLI
 * presents to the model API), the account's `user_email` and
 * `subs_active`; no refresh token, no expiry. A profile of this service is
 * therefore a static copy every host holds (sync.ts treats it as a
 * one-year token), the blob the file's own text. Usage is never polled:
 * the CLI has no usage endpoint, and what a running `muse serve` observes
 * of its own account (`usage/changed`: the 5-hour and weekly percent
 * blocks) reaches the report through `observeWindows`; the adapter's own
 * answer is unsettled so a poll never wipes that.
 *
 * On macOS the CLI defaults to the Keychain; temp-code runs it with
 * `TBH_CREDENTIAL_BACKEND=file` so the file is the whole credential, and a
 * person who signs in by hand for the app should do the same.
 */

/** `$XDG_CONFIG_HOME/muse`, else `~/.config/muse`: where the CLI reads its login. */
export function museConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  return join(xdg && xdg.trim() ? xdg : join(homedir(), '.config'), 'muse')
}

export const museAuthPath = (): string => join(museConfigDir(), 'auth.json')

export interface MuseAuth {
  schema_version?: number
  providers?: { meta?: MuseMetaCredential }
}

export interface MuseMetaCredential {
  access_token?: string
  api_key?: string
  mechanism?: string
  obtained_via?: string
  api_base_url?: string
  subs_active?: boolean
  user_full_name?: string
  user_email?: string
}

/** The Meta credential inside an auth.json text, null when it holds none. */
export function museAuthOf(text: string): MuseMetaCredential | null {
  try {
    const parsed = JSON.parse(text) as MuseAuth
    const meta = parsed?.providers?.meta
    if (!meta || typeof meta !== 'object') return null
    if (!meta.access_token && !meta.api_key) return null
    return meta
  } catch {
    return null
  }
}

/** The account a credential names: the login's email, else the key's own digest. */
export function museAccountId(cred: MuseMetaCredential): string | null {
  if (cred.user_email) return cred.user_email.toLowerCase()
  const secret = cred.api_key ?? cred.access_token
  return secret ? `key-${digest(secret).slice(0, 12)}` : null
}

const digest = (s: string): string => createHash('sha256').update(s).digest('hex')

/** A short fingerprint of the credential's secrets, to tell two logins of one account apart. */
export function museFingerprint(text: string): string | null {
  const cred = museAuthOf(text)
  if (!cred) return null
  return digest(`${cred.access_token ?? ''}|${cred.api_key ?? ''}`).slice(0, 16)
}

/** The empty file `muse logout` leaves. */
export const MUSE_LOGGED_OUT = JSON.stringify({ schema_version: 1, providers: {} }, null, 2) + '\n'

function readLive(): string | null {
  try {
    return readFileSync(museAuthPath(), 'utf8')
  } catch {
    return null
  }
}

/** Write auth.json the way the CLI does: 0600, whole file, by rename. */
export function writeMuseAuth(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, path)
}

export const USAGE_NOTE = 'Usage comes from a running Muse session'

export const muse: Adapter = {
  id: 'muse-code',
  name: 'Muse Code',
  billingUrl: 'https://accountscenter.meta.com',
  // The CLI signs in itself (`muse login`, a device code in the browser); the
  // app's loginStart runs it and captures the file, so the panel offers Add account.
  supportsLogin: true,
  targets: [],

  detect() {
    if (existsSync(museConfigDir())) return true
    const dirs = (process.env.PATH ?? '').split(':').concat(join(homedir(), '.local', 'bin'))
    return dirs.some((d) => d && existsSync(join(d, 'muse')))
  },

  async liveAccountId() {
    const text = readLive()
    const cred = text ? museAuthOf(text) : null
    return cred ? museAccountId(cred) : null
  },

  async liveFingerprint() {
    const text = readLive()
    return text ? museFingerprint(text) : null
  },

  fingerprintOf: museFingerprint,

  async capture(): Promise<Captured> {
    const text = readLive()
    const cred = text ? museAuthOf(text) : null
    const accountId = cred ? museAccountId(cred) : null
    if (!text || !cred || !accountId) throw new Error(`no Muse Code login at ${museAuthPath()}: run \`muse login\` first`)
    return { accountId, email: cred.user_email, blob: text, ...(cred.subs_active === false ? { note: 'subscription inactive' } : {}) }
  },

  async activate(blob: string | null): Promise<string[]> {
    const path = museAuthPath()
    if (blob === null) {
      if (existsSync(path)) {
        try {
          unlinkSync(path)
        } catch {
          writeMuseAuth(path, MUSE_LOGGED_OUT)
        }
      }
      return []
    }
    writeMuseAuth(path, blob.endsWith('\n') ? blob : `${blob}\n`)
    return []
  },

  async identify(blob: string) {
    const cred = museAuthOf(blob)
    const accountId = cred ? museAccountId(cred) : null
    return accountId ? { accountId, ...(cred?.user_email ? { email: cred.user_email } : {}) } : null
  },

  // No network: the windows a running session observed are already in the
  // report (observeWindows), and an unsettled empty answer leaves them there.
  async usage(blob: string): Promise<UsageResult> {
    const cred = museAuthOf(blob)
    if (!cred) return { windows: [], settled: true, expired: true, note: 'logged out' }
    if (cred.subs_active === false) return { windows: [], settled: true, note: 'subscription inactive' }
    return { windows: [], settled: false, note: USAGE_NOTE }
  }
}
