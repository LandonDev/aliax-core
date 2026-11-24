import { spawnSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { config, dataDir, hooks, type KeyWrap, type SaveOrigin, type SecretsMode } from './config'
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
  /**
   * The environment that refreshes this account's grant (temp-code's `env_…`
   * id). Absent: this machine, as every profile was before ownership existed.
   * Any other host holds an access-only copy (no refresh token) that follows
   * the owner's pushes. Meaningless for a static profile, which nothing
   * refreshes.
   */
  owner?: string
  /** A long-lived bearer (`claude setup-token`): no refresh token, nothing to refresh; it lapses at its expiry. */
  static?: boolean
  /** When a copy was last exchanged with another environment. */
  syncedAt?: number
  /** This host handed the grant to `owner` and has not yet told it so (sync.ts confirmHandoff / clearReleased). */
  releasedAt?: number
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
  if (s.mode === 'fileKey') {
    try {
      fileKey(s)
      return false
    } catch (e) {
      if (isVaultLocked(e)) return true
      throw e
    }
  }
  return s.mode === 'chromiumKey' && chromiumKey(s.keychainItem) === null
}

/** Why the vault is locked, or null when it opens (the fileKey mode's VaultLocked reason; 'keychain' for a denied Keychain). */
export function vaultLockReason(): VaultLocked['reason'] | 'keychain' | null {
  const s = config().secrets
  if (s.mode === 'fileKey') {
    try {
      fileKey(s)
      return null
    } catch (e) {
      if (isVaultLocked(e)) return e.reason
      throw e
    }
  }
  return vaultLocked() ? 'keychain' : null
}

/** Drop the cached key so the next read asks the Keychain again. */
export function resetKeyCache(): void {
  chromiumKeyCache = null
  fileKeyCache = null
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

// ---------------------------------------------------------------------------
// fileKey: the Keychain item's stand-in on a machine with no Keychain (a Linux
// agent box). A random password sits in a file with mode 0600 (default
// <dataDir>/vault.key) and feeds the very same PBKDF2 derivation, so the blobs
// are the same "v10" bytes every other mode writes: a vault sealed this way
// reads back under chromiumKey given the same password, and the macOS vault
// is untouched because no macOS host selects this mode. Chosen over Electron's
// safeStorage, which on a headless box has no keyring to lean on and falls
// back to a fixed built-in key anyway, with none of this clarity. On Windows
// the host passes a wrap (safeStorage, so DPAPI for the current user) and the
// file holds the password sealed for that user alone; 0600 means nothing there.

let fileKeyCache: { path: string; key: Buffer } | null = null

export const defaultVaultKeyPath = (): string => join(dataDir(), 'vault.key')

/**
 * The vault cannot be opened and nothing was made or rewritten to get past
 * that: the key file is missing beside sealed secrets, malformed, sealed for
 * another OS user, or sealed while this mode has no wrap to open it. A host
 * says so (one line, "Start fresh") rather than make a new key that strands
 * every secret, as a silent new key used to.
 */
export class VaultLocked extends Error {
  readonly reason: 'missing' | 'malformed' | 'unwrap' | 'busy'
  constructor(reason: VaultLocked['reason'], detail: string) {
    super(`vault locked (${reason}): ${detail}`)
    this.name = 'VaultLocked'
    this.reason = reason
  }
}

export const isVaultLocked = (e: unknown): e is VaultLocked => e instanceof VaultLocked

const WRAP_PREFIX = 'aliax-wrap:v1:'
const LEGACY_RE = /^[0-9a-f]{64}$/

/** Where the vault's sealed set lives beside the key, and the siblings a migration writes. */
const setPaths = (keyPath: string) => {
  const dir = dirname(keyPath)
  return {
    secrets: join(dataDir(), 'secrets'),
    next: join(dataDir(), 'secrets.next'),
    old: join(dataDir(), 'secrets.old'),
    keyNext: `${keyPath}.next`,
    lock: `${keyPath}.lock`,
    dir
  }
}

const hasSealed = (dir: string): boolean => {
  try {
    return readdirSync(dir).some((f) => f.endsWith('.bin'))
  } catch {
    return false
  }
}

/** Read a file or null when it is not there; every other error is thrown. */
function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/** Write a file that must not exist yet, flushed to disk before it is closed. */
function writeExclusiveFlushed(path: string, data: string | Buffer): void {
  const fd = openSync(path, 'wx', 0o600)
  try {
    writeSync(fd, typeof data === 'string' ? Buffer.from(data) : data)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** A lock older than this, or held by a process that is gone, is taken over. */
const LOCK_STALE_MS = 60_000
const LOCK_WAIT_MS = 30_000

/**
 * One holder at a time across processes for making or migrating the key:
 * an exclusive lock file with the holder's pid. Sync on purpose, like every
 * vault read: the wait is short, and a holder that died is taken over.
 */
function withKeyLock<T>(lockPath: string, work: () => T): T {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })
  const until = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      writeExclusiveFlushed(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }))
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
    let stale = false
    try {
      const held = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: number; at?: number }
      stale = !held.pid || !pidAlive(held.pid) || Date.now() - (held.at ?? 0) > LOCK_STALE_MS
    } catch {
      // half-written or gone: look again on the next turn unless it lingers
      stale = Date.now() - statMtime(lockPath) > LOCK_STALE_MS
    }
    if (stale) {
      rmSync(lockPath, { force: true })
      continue
    }
    if (Date.now() > until) throw new VaultLocked('busy', `another process holds ${lockPath}`)
    sleepSync(50)
  }
  try {
    return work()
  } finally {
    rmSync(lockPath, { force: true })
  }
}

function statMtime(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/** The key file's text, sealed when a wrap is given. */
const keyText = (password: string, wrap: KeyWrap | undefined): string =>
  wrap ? `${WRAP_PREFIX}${wrap.seal(Buffer.from(password, 'utf8')).toString('base64')}\n` : `${password}\n`

function openWrapped(text: string, wrap: KeyWrap | undefined, path: string): string {
  if (!wrap) throw new VaultLocked('unwrap', `${path} is sealed and this host has no wrap to open it`)
  let password: string
  try {
    password = wrap.open(Buffer.from(text.slice(WRAP_PREFIX.length), 'base64')).toString('utf8')
  } catch (e) {
    throw new VaultLocked('unwrap', `${path} did not open for this user (${(e as Error).message})`)
  }
  if (!LEGACY_RE.test(password)) throw new VaultLocked('malformed', `${path} opened to something that is not a key`)
  return password
}

/**
 * Finish or undo a migration a crash cut short, by what is on disk. The
 * order is: the new set in secrets.next, then vault.key.next (written only
 * once the new set round-tripped), then secrets → secrets.old, secrets.next
 * → secrets, vault.key.next → vault.key, and secrets.old removed. So a
 * vault.key.next on disk means the new set is whole and the move goes on;
 * without one the new set may be partial and is thrown away.
 */
function recoverMigration(keyPath: string, wrap: KeyWrap | undefined): void {
  const p = setPaths(keyPath)
  rmSync(`${p.keyNext}.tmp`, { force: true })
  // vault.key.next is renamed into place whole, but it is still proven to open before the new set is
  // taken: a key that does not open undoes the migration and keeps the old set and key (final review F04).
  if (existsSync(p.keyNext) && !keyOpens(p.keyNext, wrap)) {
    rmSync(p.keyNext, { force: true })
    if (existsSync(p.old)) {
      rmSync(p.secrets, { recursive: true, force: true })
      renameSync(p.old, p.secrets)
    }
    rmSync(p.next, { recursive: true, force: true })
    return
  }
  if (existsSync(p.keyNext)) {
    if (existsSync(p.next)) {
      if (!existsSync(p.old)) {
        // the swap had not started: secrets is still the old set
        if (existsSync(p.secrets)) renameSync(p.secrets, p.old)
      } else if (existsSync(p.secrets)) {
        // cut between the two moves: anything at secrets now is an empty folder a later
        // reader made, and rmdir refuses one that holds a file rather than lose it
        rmdirSync(p.secrets)
      }
      renameSync(p.next, p.secrets)
    }
    renameSync(p.keyNext, keyPath)
  } else {
    rmSync(p.next, { recursive: true, force: true })
    if (existsSync(p.old) && !hasSealed(p.secrets)) {
      if (existsSync(p.secrets)) rmdirSync(p.secrets)
      renameSync(p.old, p.secrets)
    }
  }
  rmSync(p.old, { recursive: true, force: true })
}

function keyOpens(path: string, wrap: KeyWrap | undefined): boolean {
  const text = (readOrNull(path) ?? '').trim()
  if (!text.startsWith(WRAP_PREFIX)) return false
  try {
    openWrapped(text, wrap, path)
    return true
  } catch {
    return false
  }
}

/**
 * A plain key found where a wrap is configured: re-seal every secret under a
 * NEW password (a plain copy of the old key, in a roaming profile or a
 * backup, must open nothing afterwards), prove the new set opens, write the
 * sealed key beside the old, then move both into place. A crash anywhere
 * leaves the old set or the new one whole (recoverMigration).
 */
function migrateLegacy(keyPath: string, oldPassword: string, wrap: KeyWrap): string {
  try {
    return migrateLegacyOnce(keyPath, oldPassword, wrap)
  } catch (e) {
    // Any other failure locks the vault (Start fresh offers itself) rather than throwing on every read.
    if (isVaultLocked(e)) throw e
    throw new VaultLocked('malformed', `the vault could not be moved to its sealed key: ${(e as Error).message}`)
  }
}

function migrateLegacyOnce(keyPath: string, oldPassword: string, wrap: KeyWrap): string {
  const p = setPaths(keyPath)
  const oldKey = deriveChromiumKey(oldPassword)
  const password = randomBytes(32).toString('hex')
  const key = deriveChromiumKey(password)
  rmSync(p.next, { recursive: true, force: true })
  mkdirSync(p.next, { recursive: true, mode: 0o700 })
  const files = existsSync(p.secrets) ? readdirSync(p.secrets) : []
  /** Blobs the old key never opened (sealed under a key an older build lost): unreadable before, carried as they are. */
  const unreadable = new Set<string>()
  for (const f of files) {
    const from = join(p.secrets, f)
    const to = join(p.next, f)
    if (statSync(from).isDirectory()) {
      // a folder in the set moves with it whole
      cpSync(from, to, { recursive: true })
      continue
    }
    if (!statSync(from).isFile()) continue
    if (!f.endsWith('.bin')) {
      // a side file (an app-session archive) is not sealed by this key: it moves with the set as it is
      copyFileSync(from, to)
      continue
    }
    let plain: string
    try {
      plain = chromiumDecrypt(oldKey, readFileSync(from))
    } catch {
      unreadable.add(f)
      copyFileSync(from, to)
      console.warn(`[aliax] vault: ${f} did not open under the old key; carried across unchanged`)
      continue
    }
    writeExclusiveFlushed(to, chromiumEncrypt(key, plain))
    migrationStep.current?.('sealed', f)
  }
  for (const f of files) {
    if (!f.endsWith('.bin') || unreadable.has(f) || !existsSync(join(p.next, f))) continue
    const plain = chromiumDecrypt(oldKey, readFileSync(join(p.secrets, f)))
    if (chromiumDecrypt(key, readFileSync(join(p.next, f))) !== plain) {
      throw new VaultLocked('malformed', `re-sealed ${f} did not read back`)
    }
  }
  migrationStep.current?.('checked')
  // The sealed key must open again before it is written, and it appears at vault.key.next only whole.
  let text: string
  try {
    text = keyText(password, wrap)
    if (openWrapped(text.trim(), wrap, keyPath) !== password) throw new VaultLocked('unwrap', 'the sealed key did not open again')
  } catch (e) {
    rmSync(p.next, { recursive: true, force: true })
    throw e
  }
  writeExclusiveFlushed(`${p.keyNext}.tmp`, text)
  renameSync(`${p.keyNext}.tmp`, p.keyNext)
  migrationStep.current?.('keyWritten')
  if (existsSync(p.secrets)) renameSync(p.secrets, p.old)
  migrationStep.current?.('oldMoved')
  renameSync(p.next, p.secrets)
  migrationStep.current?.('newMoved')
  renameSync(p.keyNext, keyPath)
  migrationStep.current?.('keyMoved')
  rmSync(p.old, { recursive: true, force: true })
  return password
}

/** Test seam: called after each migration step, so a test can stop the run there as a crash would. */
export const migrationStep: { current: ((step: string, file?: string) => void) | null } = { current: null }

/**
 * The key file's password. Four states, each handled once:
 * - no key and no sealed secret: a new vault, its key sealed from the start
 *   when a wrap is given (a plain key never exists then);
 * - exactly a legacy 64-hex key: used, or migrated when a wrap is given;
 * - exactly `aliax-wrap:v1:…`: opened through the wrap;
 * - anything else, or no key beside sealed secrets: VaultLocked, nothing
 *   made or rewritten.
 * Making and migrating hold one lock file across processes.
 */
function fileKeyPassword(path: string, wrap: KeyWrap | undefined): string {
  const read = (): string | null => {
    const raw = readOrNull(path)
    return raw === null ? null : raw.trim()
  }
  const settle = (text: string | null): string | null => {
    if (text === null) return null
    if (text.startsWith(WRAP_PREFIX)) return openWrapped(text, wrap, path)
    if (LEGACY_RE.test(text)) return wrap ? null : text
    if (text === '') throw new VaultLocked('malformed', `vault key file ${path} is empty`)
    throw new VaultLocked('malformed', `vault key file ${path} is not a key`)
  }
  const p = setPaths(path)
  const unsettled = (): boolean => existsSync(p.keyNext) || existsSync(p.next) || existsSync(p.old)
  if (!unsettled()) {
    const quick = settle(read())
    if (quick !== null) return quick
  }
  mkdirSync(p.dir, { recursive: true, mode: 0o700 })
  return withKeyLock(p.lock, () => {
    recoverMigration(path, wrap)
    const text = read()
    const ready = settle(text)
    if (ready !== null) return ready
    if (text !== null && wrap) return migrateLegacy(path, text, wrap)
    if (hasSealed(p.secrets)) {
      throw new VaultLocked('missing', `vault key file ${path} is missing beside sealed secrets`)
    }
    const password = randomBytes(32).toString('hex')
    const tmp = `${path}.${process.pid}.new`
    rmSync(tmp, { force: true })
    writeExclusiveFlushed(tmp, keyText(password, wrap))
    renameSync(tmp, path)
    return password
  })
}

function fileKey(s: { path?: string; wrap?: KeyWrap }): Buffer {
  const path = s.path ?? defaultVaultKeyPath()
  if (fileKeyCache?.path === path) return fileKeyCache.key
  const key = deriveChromiumKey(fileKeyPassword(path, s.wrap))
  fileKeyCache = { path, key }
  return key
}

/** The AES key behind the v10 blobs; throws when the Keychain holds it back. */
function sealingKey(s: Exclude<SecretsMode, { mode: 'safeStorage' }>): Buffer {
  if (s.mode === 'fileKey') return fileKey(s)
  const key = chromiumKey(s.keychainItem)
  if (!key) throw new Error(`vault locked: Keychain item "${s.keychainItem}" unavailable`)
  return key
}

/**
 * In fileKey mode the key is opened before any secret is read or written: an
 * open may finish a migration that moves the whole set, so a blob read
 * before it would be the old set's.
 */
function openKeyFirst(): void {
  const s = config().secrets
  if (s.mode === 'fileKey') fileKey(s)
}

function encrypt(plain: string): Buffer {
  const s = config().secrets
  if (s.mode === 'safeStorage') return s.encrypt(plain)
  return chromiumEncrypt(sealingKey(s), plain)
}

function decrypt(blob: Buffer): string {
  const s = config().secrets
  if (s.mode === 'safeStorage') return s.decrypt(blob)
  return chromiumDecrypt(sealingKey(s), blob)
}

/** Seal one profile's credentials. `origin` says whether this machine made the change (see SaveOrigin). */
export function saveSecret(serviceId: ServiceId, name: string, blob: string, origin: SaveOrigin = 'local'): void {
  openKeyFirst()
  writeAtomic(`${fileStem(serviceId, name)}.bin`, encrypt(blob))
  hooks().onSecretSaved?.(serviceId, name, origin)
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
  openKeyFirst()
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
