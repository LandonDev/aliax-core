import { execFile } from 'node:child_process'
import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/**
 * Read/write cookies in another Chromium-based app's cookie store on macOS.
 * Values are AES-128-CBC encrypted ("v10") with a key derived from the app's
 * Safe Storage password in the user's Keychain. Cookie-DB schema version >= 24
 * additionally prefixes the plaintext with SHA256(host_key).
 */

export interface PlainCookie {
  name: string
  value: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  /** Unix seconds; absent for session cookies. */
  expirationDate?: number
  sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
  /** Chromium partitioning columns, preserved verbatim when we read them. */
  sourceType?: number
  hasCrossSiteAncestor?: number
}

const IV = Buffer.alloc(16, ' ')
const CHROME_EPOCH_OFFSET_MS = 11644473600000

async function storageKey(keychainService: string): Promise<Buffer> {
  const { stdout } = await exec('security', ['find-generic-password', '-s', keychainService, '-w'])
  return pbkdf2Sync(stdout.replace(/\n$/, ''), 'saltysalt', 1003, 16, 'sha1')
}

function dbVersion(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
    | { value?: string | number }
    | undefined
  return Number(row?.value ?? 0)
}

const SAMESITE_TO_INT = { unspecified: -1, no_restriction: 0, lax: 1, strict: 2 } as const
const INT_TO_SAMESITE: Record<number, PlainCookie['sameSite']> = {
  [-1]: 'unspecified',
  0: 'no_restriction',
  1: 'lax',
  2: 'strict'
}

const toChromeMicros = (unixMs: number): bigint =>
  BigInt(Math.floor(unixMs) + CHROME_EPOCH_OFFSET_MS) * 1000n

export async function readCookies(
  cookiesDbPath: string,
  keychainService: string,
  domainContains: string
): Promise<PlainCookie[]> {
  const key = await storageKey(keychainService)
  const db = new DatabaseSync(cookiesDbPath, { readOnly: true })
  try {
    const version = dbVersion(db)
    // Chromium timestamps overflow JS numbers, so read integers as BigInt.
    const select = db.prepare('SELECT * FROM cookies WHERE host_key LIKE ?')
    select.setReadBigInts(true)
    const rows = select.all(`%${domainContains}%`) as Record<string, unknown>[]
    const out: PlainCookie[] = []
    for (const row of rows) {
      let value = typeof row.value === 'string' ? row.value : ''
      const enc = row.encrypted_value
      if (enc instanceof Uint8Array && enc.length > 3) {
        const buf = Buffer.from(enc)
        if (buf.subarray(0, 3).toString() === 'v10') {
          try {
            const decipher = createDecipheriv('aes-128-cbc', key, IV)
            let plain = Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()])
            if (version >= 24) plain = plain.subarray(32)
            value = plain.toString('utf8')
          } catch {
            continue // undecryptable row; skip rather than corrupt
          }
        }
      }
      const expiresUtc = BigInt((row.expires_utc as bigint | number | null) ?? 0)
      out.push({
        name: String(row.name ?? ''),
        value,
        domain: String(row.host_key ?? ''),
        path: String(row.path ?? '/'),
        secure: Number(row.is_secure ?? 0) === 1,
        httpOnly: Number(row.is_httponly ?? 0) === 1,
        expirationDate:
          expiresUtc > 0n
            ? Number(expiresUtc / 1000000n) - CHROME_EPOCH_OFFSET_MS / 1000
            : undefined,
        sameSite: INT_TO_SAMESITE[Number(row.samesite ?? -1)] ?? 'unspecified',
        sourceType: Number(row.source_type ?? 0),
        hasCrossSiteAncestor: Number(row.has_cross_site_ancestor ?? 0)
      })
    }
    return out
  } finally {
    db.close()
  }
}

/** Replace all cookies for the given domains with the provided set. App must be quit. */
export async function writeCookies(
  cookiesDbPath: string,
  keychainService: string,
  cookies: PlainCookie[],
  clearDomainsContaining: string[]
): Promise<number> {
  const key = await storageKey(keychainService)
  const db = new DatabaseSync(cookiesDbPath)
  try {
    const version = dbVersion(db)
    const columns = db.prepare('PRAGMA table_info(cookies)').all() as {
      name: string
      type: string
    }[]

    const clear = db.prepare('DELETE FROM cookies WHERE host_key LIKE ?')
    for (const domain of clearDomainsContaining) clear.run(`%${domain}%`)

    let creation = toChromeMicros(Date.now())
    let written = 0
    const insert = db.prepare(
      `INSERT INTO cookies (${columns.map((c) => c.name).join(',')}) VALUES (${columns.map(() => '?').join(',')})`
    )
    for (const c of cookies) {
      let plaintext = Buffer.from(c.value, 'utf8')
      if (version >= 24) {
        plaintext = Buffer.concat([createHash('sha256').update(c.domain).digest(), plaintext])
      }
      const cipher = createCipheriv('aes-128-cbc', key, IV)
      const encrypted = Buffer.concat([Buffer.from('v10'), cipher.update(plaintext), cipher.final()])
      const expires = c.expirationDate ? toChromeMicros(c.expirationDate * 1000) : 0n

      const row: Record<string, unknown> = {
        creation_utc: creation,
        host_key: c.domain,
        top_frame_site_key: '',
        name: c.name,
        value: '',
        encrypted_value: encrypted,
        path: c.path,
        expires_utc: expires,
        is_secure: c.secure ? 1 : 0,
        is_httponly: c.httpOnly ? 1 : 0,
        last_access_utc: creation,
        has_expires: c.expirationDate ? 1 : 0,
        is_persistent: c.expirationDate ? 1 : 0,
        priority: 1,
        samesite: SAMESITE_TO_INT[c.sameSite ?? 'unspecified'],
        source_scheme: 2,
        source_port: 443,
        last_update_utc: creation,
        source_type: c.sourceType ?? 1,
        has_cross_site_ancestor: c.hasCrossSiteAncestor ?? 1
      }
      insert.run(
        ...columns.map((col) => {
          if (col.name in row) return row[col.name] as never
          return (col.type.toUpperCase().includes('INT') ? 0 : '') as never
        })
      )
      creation += 1n
      written++
    }
    return written
  } finally {
    db.close()
  }
}
