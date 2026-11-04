import { fetch } from '../config'
import type { Adapter, Captured, UsageResult } from './types'
import { retryAfterMs } from './types'

/**
 * The Meta Model API (dev.meta.ai): Muse Wonder and Muse Spark behind one
 * origin, paid per token, authenticated with a dashboard-made key
 * `LLM_<numeric id>_<secret>`. There is no sign-in flow, no live CLI
 * credential and no refresh: the key IS the account. A profile of this
 * service is static, owned by nobody and held by every host (sync.ts treats
 * it as a one-year token). The usage report is a probe of `/v1/models`: a
 * 200 says the key works, a 401 or 403 that it was revoked.
 */
export const META_ORIGIN = 'https://api.meta.ai'

/** The key's shape: the numeric id between the underscores is the account. */
export const META_KEY_RE = /^LLM_(\d+)_\S+$/

/** The account id a key names, null for anything that is not a Meta key. */
export function metaAccountId(key: string): string | null {
  const m = META_KEY_RE.exec(key.trim())
  return m ? m[1] : null
}

/** The key inside a stored blob, null when the blob holds none. */
export function metaKeyOf(blob: string): string | null {
  try {
    const key = (JSON.parse(blob) as { key?: unknown }).key
    return typeof key === 'string' && key ? key : null
  } catch {
    return null
  }
}

/** The blob a Meta key is stored as. */
export const metaBlob = (key: string): string => JSON.stringify({ key: key.trim() })

/** What `GET /v1/models` says about a key, in the usage report's terms. */
export async function probeKey(key: string): Promise<UsageResult> {
  const res = await fetch(`${META_ORIGIN}/v1/models`, { headers: { Authorization: `Bearer ${key}` } })
  if (res.ok) return { windows: [], settled: true, note: 'pay as you go' }
  if (res.status === 401 || res.status === 403) return { windows: [], settled: true, expired: true, note: 'key revoked' }
  if (res.status === 429) return { windows: [], note: 'usage temporarily unavailable', retryAfterMs: retryAfterMs(res) }
  return { windows: [], note: `usage unavailable (${res.status})` }
}

export const meta: Adapter = {
  id: 'meta',
  name: 'Meta Model API',
  billingUrl: 'https://dev.meta.ai',
  supportsLogin: false,
  targets: [],

  // A key-only service has nothing to install: it is always available.
  detect: () => true,

  async liveAccountId() {
    return null
  },

  async capture(): Promise<Captured> {
    throw new Error('no live credential to capture for meta: add a key instead')
  },

  async activate(): Promise<string[]> {
    return []
  },

  async identify(blob: string) {
    const key = metaKeyOf(blob)
    const accountId = key ? metaAccountId(key) : null
    return accountId ? { accountId } : null
  },

  async usage(blob: string): Promise<UsageResult> {
    const key = metaKeyOf(blob)
    if (!key) return { windows: [], settled: true, note: 'no key saved' }
    return probeKey(key)
  }
}
