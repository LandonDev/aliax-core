import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configure, type KeyWrap } from '../src/config'
import * as vault from '../src/vault'
import { noFetch, tempCore } from './helpers'

/** A stand-in for DPAPI: what one user seals, only that user opens. */
const fakeWrap = (user: string): KeyWrap => ({
  seal: (b) => Buffer.from(`${user}|${b.toString('hex')}`),
  open: (b) => {
    const [who, hex] = b.toString().split('|')
    if (who !== user) throw new Error('not this user')
    return Buffer.from(hex, 'hex')
  }
})

let cleanup = (): void => {}
afterEach(() => {
  vault.migrationStep.current = null
  vault.keyLockTest.step = null
  vault.keyLockTest.waitMs = 30_000
  vault.resetKeyCache()
  cleanup()
})

function legacyVault(): { dataDir: string; keyPath: string; password: string } {
  const { dataDir, cleanup: c } = tempCore()
  cleanup = c
  configure({ dataDir, fetch: noFetch, secrets: { mode: 'fileKey' } })
  vault.resetKeyCache()
  vault.saveSecret('claude-code', 'one', 'fake-token-one')
  vault.saveSecret('codex', 'two', '{"fake":"two"}')
  writeFileSync(vault.extraPath('claude-code', 'one', 'claude-desktop.tar.gz'), 'side file')
  const keyPath = join(dataDir, 'vault.key')
  return { dataDir, keyPath, password: readFileSync(keyPath, 'utf8').trim() }
}

const useWrap = (dataDir: string, user = 'tcuser'): void => {
  configure({ dataDir, fetch: noFetch, secrets: { mode: 'fileKey', wrap: fakeWrap(user) } })
  vault.resetKeyCache()
}

const lockOf = (e: unknown): string | null => (vault.isVaultLocked(e) ? e.reason : null)

describe('fileKey with a wrap', () => {
  it('makes a new vault sealed from the start, so a plain key never exists', () => {
    const { dataDir, cleanup: c } = tempCore()
    cleanup = c
    useWrap(dataDir)
    vault.saveSecret('claude-code', 'a', 'fake')
    const text = readFileSync(join(dataDir, 'vault.key'), 'utf8')
    expect(text.startsWith('aliax-wrap:v1:')).toBe(true)
    expect(text).not.toMatch(/^[0-9a-f]{64}\s*$/)
    vault.resetKeyCache()
    expect(vault.readSecret('claude-code', 'a')).toBe('fake')
    expect(vault.vaultLockReason()).toBeNull()
  })

  it('finishes a first create a crash cut short: a leftover temp key and a dead holder lock', () => {
    const { dataDir, cleanup: c } = tempCore()
    cleanup = c
    const keyPath = join(dataDir, 'vault.key')
    writeFileSync(`${keyPath}.999999.new`, 'aliax-wrap:v1:half')
    writeFileSync(`${keyPath}.lock`, JSON.stringify({ pid: 999_999_999, at: Date.now() }))
    useWrap(dataDir)
    vault.saveSecret('codex', 'a', 'fake')
    vault.resetKeyCache()
    expect(vault.readSecret('codex', 'a')).toBe('fake')
    expect(existsSync(`${keyPath}.lock`)).toBe(false)
  })

  it('migrates a legacy plain key: every secret re-sealed under a new password, side files kept', () => {
    const { dataDir, keyPath, password } = legacyVault()
    useWrap(dataDir)
    expect(vault.readSecret('claude-code', 'one')).toBe('fake-token-one')
    expect(vault.readSecret('codex', 'two')).toBe('{"fake":"two"}')
    expect(readFileSync(keyPath, 'utf8').startsWith('aliax-wrap:v1:')).toBe(true)
    expect(readFileSync(vault.extraPath('claude-code', 'one', 'claude-desktop.tar.gz'), 'utf8')).toBe('side file')
    for (const sib of ['secrets.next', 'secrets.old', 'vault.key.next', 'vault.key.lock']) {
      expect(existsSync(join(dataDir, sib))).toBe(false)
    }
    // A plain copy of the old key, in a roaming profile or a backup, opens nothing now.
    const oldKey = vault.deriveChromiumKey(password)
    for (const f of readdirSync(join(dataDir, 'secrets')).filter((f) => f.endsWith('.bin'))) {
      expect(() => vault.chromiumDecrypt(oldKey, readFileSync(join(dataDir, 'secrets', f)))).toThrow()
    }
    vault.resetKeyCache()
    expect(vault.readSecret('codex', 'two')).toBe('{"fake":"two"}')
  })

  for (const step of ['sealed', 'checked', 'keyWritten', 'oldMoved', 'newMoved', 'keyMoved']) {
    it(`a migration cut at "${step}" leaves a whole set, and the next open finishes or undoes it`, () => {
      const { dataDir, keyPath } = legacyVault()
      useWrap(dataDir)
      vault.migrationStep.current = (s) => {
        if (s === step) throw new Error(`crash at ${s}`)
      }
      expect(() => vault.readSecret('claude-code', 'one')).toThrow(`crash at ${step}`)
      vault.migrationStep.current = null
      // A real crash leaves its lock behind, held by a process that is gone.
      writeFileSync(`${keyPath}.lock`, JSON.stringify({ pid: 999_999_999, at: Date.now() }))
      vault.resetKeyCache()
      expect(vault.readSecret('claude-code', 'one')).toBe('fake-token-one')
      expect(vault.readSecret('codex', 'two')).toBe('{"fake":"two"}')
      expect(readFileSync(vault.extraPath('claude-code', 'one', 'claude-desktop.tar.gz'), 'utf8')).toBe('side file')
      expect(readFileSync(keyPath, 'utf8').startsWith('aliax-wrap:v1:')).toBe(true)
      for (const sib of ['secrets.next', 'secrets.old', 'vault.key.next']) {
        expect(existsSync(join(dataDir, sib))).toBe(false)
      }
    })
  }

  it('carries a blob the old key never opened, and a folder in the set, across the migration; the rest opens', () => {
    const { dataDir, keyPath } = legacyVault()
    const secrets = join(dataDir, 'secrets')
    writeFileSync(join(secrets, 'claude-code__lost.bin'), Buffer.concat([Buffer.from('v10'), Buffer.alloc(32, 7)]))
    mkdirSync(join(secrets, 'nested'))
    writeFileSync(join(secrets, 'nested', 'kept.txt'), 'kept')
    useWrap(dataDir)
    expect(vault.vaultLocked()).toBe(false)
    expect(vault.readSecret('claude-code', 'one')).toBe('fake-token-one')
    expect(readFileSync(keyPath, 'utf8').startsWith('aliax-wrap:v1:')).toBe(true)
    expect(readFileSync(join(secrets, 'claude-code__lost.bin')).subarray(3)).toEqual(Buffer.alloc(32, 7))
    expect(readFileSync(join(secrets, 'nested', 'kept.txt'), 'utf8')).toBe('kept')
  })

  it('locks, and makes nothing, when the key is missing beside sealed secrets', () => {
    const { dataDir, keyPath } = legacyVault()
    rmSync(keyPath)
    useWrap(dataDir)
    let err: unknown
    try {
      vault.readSecret('claude-code', 'one')
    } catch (e) {
      err = e
    }
    expect(lockOf(err)).toBe('missing')
    expect(existsSync(keyPath)).toBe(false)
    expect(vault.vaultLocked()).toBe(true)
    expect(vault.vaultLockReason()).toBe('missing')
    // the box's plain mode refuses the same way rather than strand the secrets under a new key
    configure({ dataDir, fetch: noFetch, secrets: { mode: 'fileKey' } })
    vault.resetKeyCache()
    expect(vault.vaultLockReason()).toBe('missing')
    expect(existsSync(keyPath)).toBe(false)
  })

  it('locks on a malformed key and leaves the file as it was', () => {
    const { dataDir, keyPath } = legacyVault()
    writeFileSync(keyPath, 'not a key at all\n')
    useWrap(dataDir)
    expect(vault.vaultLockReason()).toBe('malformed')
    expect(readFileSync(keyPath, 'utf8')).toBe('not a key at all\n')
    writeFileSync(keyPath, 'aliax-wrap:v1:' + Buffer.from('tcuser|zz').toString('base64'))
    vault.resetKeyCache()
    expect(vault.vaultLockReason()).toBe('malformed')
  })

  it('a key sealed for one user does not open for another, nor with no wrap at all', () => {
    const { dataDir, cleanup: c } = tempCore()
    cleanup = c
    useWrap(dataDir, 'tcuser')
    vault.saveSecret('codex', 'a', 'fake')
    const before = readFileSync(join(dataDir, 'vault.key'), 'utf8')
    useWrap(dataDir, 'tcuser2')
    expect(vault.vaultLockReason()).toBe('unwrap')
    configure({ dataDir, fetch: noFetch, secrets: { mode: 'fileKey' } })
    vault.resetKeyCache()
    expect(vault.vaultLockReason()).toBe('unwrap')
    expect(readFileSync(join(dataDir, 'vault.key'), 'utf8')).toBe(before)
    useWrap(dataDir, 'tcuser')
    expect(vault.readSecret('codex', 'a')).toBe('fake')
  })

  const bun = spawnSync('bun', ['--version']).status === 0 ? 'bun' : null
  it.skipIf(!bun)('two processes opening one legacy vault at once migrate it once and both read it', async () => {
    const { dataDir } = legacyVault()
    const src = resolve(__dirname, '../src')
    const script = `
      import { configure } from '${src}/config.ts'
      import * as vault from '${src}/vault.ts'
      const wrap = {
        seal: (b) => Buffer.from('tcuser|' + b.toString('hex')),
        open: (b) => { const [w, h] = b.toString().split('|'); if (w !== 'tcuser') throw new Error('no'); return Buffer.from(h, 'hex') }
      }
      configure({ dataDir: process.argv[2], fetch: async () => { throw new Error('no') }, secrets: { mode: 'fileKey', wrap } })
      console.log(vault.readSecret('claude-code', 'one') + ' ' + vault.readSecret('codex', 'two'))
    `
    const scriptPath = join(dataDir, 'open.ts')
    writeFileSync(scriptPath, script)
    const run = (): Promise<string> =>
      new Promise((done, fail) => {
        const child = spawn(bun!, [scriptPath, dataDir])
        let out = ''
        let err = ''
        child.stdout.on('data', (d) => (out += d))
        child.stderr.on('data', (d) => (err += d))
        child.on('exit', (code) => (code === 0 ? done(out.trim()) : fail(new Error(err))))
      })
    const outs = await Promise.all([run(), run(), run()])
    expect(outs).toEqual(Array(3).fill('fake-token-one {"fake":"two"}'))
    useWrap(dataDir)
    expect(vault.readSecret('codex', 'two')).toBe('{"fake":"two"}')
  }, 30_000)
})

describe('the migration key is whole and proven before the new set is taken (final review F04)', () => {
  it('a vault.key.next that does not open undoes the migration and keeps the old set', () => {
    const { dataDir, keyPath } = legacyVault()
    useWrap(dataDir)
    vault.migrationStep.current = (s) => {
      if (s === 'keyWritten') throw new Error('crash')
    }
    expect(() => vault.readSecret('claude-code', 'one')).toThrow('crash')
    vault.migrationStep.current = null
    // the key a power loss left half written
    writeFileSync(`${keyPath}.next`, 'aliax-wrap:v1:')
    vault.resetKeyCache()
    expect(vault.readSecret('claude-code', 'one')).toBe('fake-token-one')
    expect(vault.readSecret('codex', 'two')).toBe('{"fake":"two"}')
    expect(readFileSync(keyPath, 'utf8').startsWith('aliax-wrap:v1:')).toBe(true)
  })

  it('a wrap whose seal does not open again leaves the plain key and the old set as they were', () => {
    const { dataDir, keyPath, password } = legacyVault()
    configure({ dataDir, fetch: noFetch, secrets: { mode: 'fileKey', wrap: { seal: () => Buffer.from('junk'), open: () => Buffer.from('nope') } } })
    vault.resetKeyCache()
    expect(() => vault.readSecret('claude-code', 'one')).toThrow()
    expect(readFileSync(keyPath, 'utf8').trim()).toBe(password)
    for (const sib of ['secrets.next', 'secrets.old', 'vault.key.next']) expect(existsSync(join(dataDir, sib))).toBe(false)
    configure({ dataDir, fetch: noFetch, secrets: { mode: 'fileKey' } })
    vault.resetKeyCache()
    expect(vault.readSecret('claude-code', 'one')).toBe('fake-token-one')
  })
})

describe('every secret read and write shares the vault lock and the committed key (security review F14)', () => {
  it('a process that opened the plain key before another migrated the vault cannot write an old-key blob into the new set', async () => {
    const { dataDir, keyPath } = legacyVault()
    // this module instance: plain mode, the legacy key opened and cached
    expect(vault.readSecret('codex', 'two')).toBe('{"fake":"two"}')
    // another process (a second instance of the modules) with the wrap migrates the vault
    vi.resetModules()
    const config2 = await import('../src/config')
    const vault2 = await import('../src/vault')
    config2.configure({ dataDir, fetch: noFetch, secrets: { mode: 'fileKey', wrap: fakeWrap('tcuser') } })
    expect(vault2.readSecret('claude-code', 'one')).toBe('fake-token-one')
    expect(readFileSync(keyPath, 'utf8').startsWith('aliax-wrap:v1:')).toBe(true)
    // the first process, still holding the old key, writes: refused, since it cannot open the committed key
    expect(() => vault.saveSecret('claude-code', 'one', 'stale-token')).toThrow()
    useWrap(dataDir)
    expect(vault.readSecret('claude-code', 'one')).toBe('fake-token-one')
    expect(vault.readSecret('codex', 'two')).toBe('{"fake":"two"}')
  })

  it('a process holding a key that is no longer committed opens the new one and seals under it', async () => {
    const { dataDir, cleanup: c } = tempCore()
    cleanup = c
    useWrap(dataDir)
    vault.saveSecret('codex', 'a', 'first')
    // another process replaces the committed key (the files on disk change under this one's cache)
    vi.resetModules()
    const config2 = await import('../src/config')
    const vault2 = await import('../src/vault')
    config2.configure({ dataDir, fetch: noFetch, secrets: { mode: 'fileKey', wrap: fakeWrap('tcuser') } })
    rmSync(join(dataDir, 'secrets'), { recursive: true })
    rmSync(join(dataDir, 'vault.key'))
    vault2.saveSecret('codex', 'b', 'second')
    vault.saveSecret('codex', 'a', 'third')
    vault2.resetKeyCache()
    expect(vault2.readSecret('codex', 'a')).toBe('third')
    expect(vault2.readSecret('codex', 'b')).toBe('second')
  })

  it('two waiters on one stale lock: neither removes the fresh lock the other made', () => {
    const { dataDir, cleanup: c } = tempCore()
    cleanup = c
    useWrap(dataDir)
    const lock = join(dataDir, 'vault.key.lock')
    writeFileSync(lock, JSON.stringify({ pid: 999_999_999, at: Date.now() }))
    // the other waiter judged the same lock stale, removed it and made its own just before this one looks again
    const other = JSON.stringify({ pid: process.ppid, at: Date.now(), id: 'other' })
    let seen: string | null = null
    vault.keyLockTest.step = (step) => {
      if (step === 'stale' && seen === null) {
        rmSync(lock)
        writeFileSync(lock, other)
        seen = 'made'
      } else if (step === 'waiting' && seen === 'made') {
        // the other waiter's lock is still whole while it works; then it lets go
        seen = readFileSync(lock, 'utf8')
        rmSync(lock)
      }
    }
    vault.saveSecret('codex', 'a', 'fake')
    expect(seen).toBe(other)
    expect(vault.readSecret('codex', 'a')).toBe('fake')
    expect(existsSync(lock)).toBe(false)
  })

  it('a live holder is not taken over for its age: a lock a minute old waits, then reads busy', () => {
    const { dataDir, cleanup: c } = tempCore()
    cleanup = c
    useWrap(dataDir)
    vault.saveSecret('codex', 'a', 'fake')
    const lock = join(dataDir, 'vault.key.lock')
    const held = JSON.stringify({ pid: process.ppid, at: Date.now() - 120_000 })
    writeFileSync(lock, held)
    vault.keyLockTest.waitMs = 200
    let err: unknown
    try {
      vault.readSecret('codex', 'a')
    } catch (e) {
      err = e
    }
    expect(lockOf(err)).toBe('busy')
    expect(readFileSync(lock, 'utf8')).toBe(held)
    rmSync(lock)
    expect(vault.readSecret('codex', 'a')).toBe('fake')
  })
})
