import { spawnSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { config, dataDir } from './config'
import { writeAtomic } from './fs'
import { randomAccountColor } from './shared/colors'
import type { ServiceId } from './shared/types'

export interface StoredProfile {
  name: string
  accountId: string
  email?: string
  nickname?: string
  color?: string
  /** True once a claude.ai-style app session is stored alongside the credentials. */
  hasAppSession?: boolean
  createdAt: number
  lastActivatedAt?: number
}

type Meta = Partial<Record<ServiceId, StoredProfile[]>>

const metaPath = (): string => join(dataDir(), 'profiles.json')

function secretsDir(): string {
  const dir = join(dataDir(), 'secrets')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

const fileStem = (serviceId: ServiceId, name: string): string =>
  join(secretsDir(), `${serviceId}__${encodeURIComponent(name)}`)

export function loadMeta(): Meta {
  try {
    return JSON.parse(readFileSync(metaPath(), 'utf8'))
  } catch {
    return {}
  }
}

export function saveMeta(meta: Meta): void {
  writeAtomic(metaPath(), JSON.stringify(meta, null, 2))
}

export function profiles(serviceId: ServiceId): StoredProfile[] {
  return loadMeta()[serviceId] ?? []
}

export function upsertProfile(serviceId: ServiceId, profile: StoredProfile): void {
  const meta = loadMeta()
  const list = meta[serviceId] ?? []
  // Every account carries a colour from birth; the UI leans on it for identity.
  if (!profile.color) profile.color = randomAccountColor(list.map((p) => p.color))
  const i = list.findIndex((p) => p.name === profile.name)
  if (i >= 0) list[i] = profile
  else list.push(profile)
  meta[serviceId] = list
  saveMeta(meta)
}

/** One-time backfill: accounts saved before colours existed get one at startup. */
export function ensureColors(): void {
  const meta = loadMeta()
  let changed = false
  for (const list of Object.values(meta)) {
    for (const p of list) {
      if (p.color) continue
      p.color = randomAccountColor(list.map((q) => q.color))
      changed = true
    }
  }
  if (changed) saveMeta(meta)
}

export function deleteProfile(serviceId: ServiceId, name: string): void {
  const meta = loadMeta()
  meta[serviceId] = (meta[serviceId] ?? []).filter((p) => p.name !== name)
  saveMeta(meta)
  for (const suffix of ['bin', 'claude-desktop.tar.gz']) {
    rmSync(`${fileStem(serviceId, name)}.${suffix}`, { force: true })
  }
}

// ---------------------------------------------------------------------------
// Sealing. Both modes produce the bytes Chromium's OSCrypt writes on macOS:
// "v10" + AES-128-CBC(key = PBKDF2-SHA1(keychain password, "saltysalt", 1003,
// 16 bytes), IV = 16 spaces). Electron's safeStorage IS that scheme with the
// "<app name> Safe Storage" Keychain item, so a second app holding the same
// item's password reads the same vault byte for byte.

const V10 = 'v10'

export function deriveChromiumKey(password: string): Buffer {
  return pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
}

export function chromiumEncrypt(key: Buffer, plain: string): Buffer {
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
  return Buffer.concat([Buffer.from(V10), cipher.update(plain, 'utf8'), cipher.final()])
}

export function chromiumDecrypt(key: Buffer, blob: Buffer): string {
  if (blob.subarray(0, 3).toString() !== V10) throw new Error('not a v10 blob')
  const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
  return Buffer.concat([decipher.update(blob.subarray(3)), decipher.final()]).toString('utf8')
}

/** Read one Keychain item's password. Null when denied, missing, or the prompt hung. */
export function keychainPassword(item: string): string | null {
  if (process.platform !== 'darwin') return null
  const found = spawnSync('security', ['find-generic-password', '-w', '-s', item], {
    encoding: 'utf8',
    timeout: 10_000
  })
  if (found.status !== 0 || !found.stdout) return null
  return found.stdout.trim()
}

/**
 * Whether the vault is currently sealed off by the Keychain. In chromiumKey
 * mode a denied prompt leaves us with no key: profiles still list, but every
 * secret read throws. Hosts show "locked" rather than "unreadable" then.
 */
let chromiumKeyCache: { item: string; key: Buffer | null } | null = null

export function vaultLocked(): boolean {
  const s = config().secrets
  return s.mode === 'chromiumKey' && chromiumKey(s.keychainItem) === null
}

/** Drop the cached key so the next read asks the Keychain again. */
export function resetKeyCache(): void {
  chromiumKeyCache = null
}

function chromiumKey(item: string): Buffer | null {
  if (chromiumKeyCache?.item === item && chromiumKeyCache.key) return chromiumKeyCache.key
  const password = keychainPassword(item)
  const key = password ? deriveChromiumKey(password) : null
  chromiumKeyCache = { item, key }
  return key
}

/** Test seam: hand the vault a fixed key instead of the Keychain. */
export function useFixedChromiumKey(item: string, key: Buffer): void {
  chromiumKeyCache = { item, key }
}

function encrypt(plain: string): Buffer {
  const s = config().secrets
  if (s.mode === 'safeStorage') return s.encrypt(plain)
  const key = chromiumKey(s.keychainItem)
  if (!key) throw new Error(`vault locked: Keychain item "${s.keychainItem}" unavailable`)
  return chromiumEncrypt(key, plain)
}

function decrypt(blob: Buffer): string {
  const s = config().secrets
  if (s.mode === 'safeStorage') return s.decrypt(blob)
  const key = chromiumKey(s.keychainItem)
  if (!key) throw new Error(`vault locked: Keychain item "${s.keychainItem}" unavailable`)
  return chromiumDecrypt(key, blob)
}

export function saveSecret(serviceId: ServiceId, name: string, blob: string): void {
  writeAtomic(`${fileStem(serviceId, name)}.bin`, encrypt(blob))
}

/**
 * Names Aliax has run under. `safeStorage` derives its key from a Keychain
 * item called "<app name> Safe Storage" and looks it up case-sensitively, so
 * every rename — dev vs packaged, most of all — strands the blobs written under
 * the previous name (invariant 17). Only the safeStorage owner recovers and
 * re-seals them; a chromiumKey reader never rewrites what it did not seal.
 */
const PAST_APP_NAMES = ['aliax', 'Aliax', 'Electron']

function decryptWithPastKey(buf: Buffer): string | null {
  if (process.platform !== 'darwin' || buf.subarray(0, 3).toString() !== V10) return null
  for (const appName of PAST_APP_NAMES) {
    if (appName === config().appName) continue
    const password = keychainPassword(`${appName} Safe Storage`)
    if (!password) continue
    try {
      return chromiumDecrypt(deriveChromiumKey(password), buf)
    } catch {
      // wrong key for this blob; try the next name
    }
  }
  return null
}

export function readSecret(serviceId: ServiceId, name: string): string | null {
  const path = `${fileStem(serviceId, name)}.bin`
  if (!existsSync(path)) return null
  const raw = readFileSync(path)
  try {
    return decrypt(raw)
  } catch (e) {
    if (config().secrets.mode !== 'safeStorage') throw e
    const recovered = decryptWithPastKey(raw)
    if (recovered === null) throw e
    // Re-encrypt under the current name so this costs nothing next time.
    saveSecret(serviceId, name, recovered)
    return recovered
  }
}

/** Path for an adapter's larger side file (e.g. an app-session archive) tied to a profile. */
export function extraPath(serviceId: ServiceId, name: string, suffix: string): string {
  return `${fileStem(serviceId, name)}.${suffix}`
}

/** Move side files captured under a placeholder profile name to the real one. */
export function adoptExtras(serviceId: ServiceId, from: string, to: string): void {
  const dir = secretsDir()
  const fromPrefix = `${serviceId}__${encodeURIComponent(from)}.`
  const toPrefix = `${serviceId}__${encodeURIComponent(to)}.`
  for (const f of readdirSync(dir)) {
    if (f.startsWith(fromPrefix) && !f.endsWith('.bin')) {
      renameSync(join(dir, f), join(dir, toPrefix + f.slice(fromPrefix.length)))
    }
  }
}

/** Random 16-byte key for tests. */
export const randomChromiumKey = (): Buffer => randomBytes(16)
