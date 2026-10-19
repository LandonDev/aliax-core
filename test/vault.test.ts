import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { configure } from '../src/config'
import * as vault from '../src/vault'
import { noFetch, tempCore } from './helpers'

let cleanup = (): void => {}
afterEach(() => cleanup())

describe('vault', () => {
  it('round-trips a secret in chromiumKey mode and writes v10 bytes', () => {
    ;({ cleanup } = tempCore())
    vault.saveSecret('codex', 'me', '{"tokens":1}')
    expect(vault.readSecret('codex', 'me')).toBe('{"tokens":1}')
    const raw = readFileSync(vault.extraPath('codex', 'me', 'bin'))
    expect(raw.subarray(0, 3).toString()).toBe('v10')
  })

  it('reads the same bytes in safeStorage mode when both hold one key', () => {
    const { dataDir, cleanup: c } = tempCore()
    cleanup = c
    const key = vault.deriveChromiumKey('shared-password')
    vault.useFixedChromiumKey('Test Safe Storage', key)
    vault.saveSecret('claude-code', 'a', 'hello')
    configure({
      dataDir,
      fetch: noFetch,
      appName: 'Aliax',
      secrets: {
        mode: 'safeStorage',
        encrypt: (s) => vault.chromiumEncrypt(key, s),
        decrypt: (b) => vault.chromiumDecrypt(key, b)
      }
    })
    expect(vault.readSecret('claude-code', 'a')).toBe('hello')
  })

  it('throws, and never rewrites, when the chromium key is wrong', () => {
    ;({ cleanup } = tempCore())
    vault.saveSecret('codex', 'x', 'secret')
    const before = readFileSync(vault.extraPath('codex', 'x', 'bin'))
    vault.useFixedChromiumKey('Test Safe Storage', vault.randomChromiumKey())
    expect(() => vault.readSecret('codex', 'x')).toThrow()
    expect(readFileSync(vault.extraPath('codex', 'x', 'bin')).equals(before)).toBe(true)
  })

  it('profiles persist through upsert and delete, and colours are assigned', () => {
    ;({ cleanup } = tempCore())
    vault.upsertProfile('codex', { name: 'one', accountId: '1', createdAt: 1 })
    vault.upsertProfile('codex', { name: 'two', accountId: '2', createdAt: 2 })
    expect(vault.profiles('codex').map((p) => p.name)).toEqual(['one', 'two'])
    expect(vault.profiles('codex')[0].color).toBeTruthy()
    vault.deleteProfile('codex', 'one')
    expect(vault.profiles('codex').map((p) => p.name)).toEqual(['two'])
  })
})

describe('vault fileKey mode', () => {
  it('seals with a 0600 key file and writes the same v10 bytes chromiumKey reads', () => {
    const { dataDir, cleanup: c } = tempCore()
    cleanup = c
    configure({ dataDir, fetch: noFetch, secrets: { mode: 'fileKey' } })
    vault.resetKeyCache()
    expect(vault.vaultLocked()).toBe(false)
    vault.saveSecret('claude-code', 'box', '{"keychain":"x"}')
    const keyPath = join(dataDir, 'vault.key')
    expect(statSync(keyPath).mode & 0o777).toBe(0o600)
    const password = readFileSync(keyPath, 'utf8').trim()
    expect(password).toMatch(/^[0-9a-f]{64}$/)
    const raw = readFileSync(vault.extraPath('claude-code', 'box', 'bin'))
    expect(raw.subarray(0, 3).toString()).toBe('v10')
    expect(vault.chromiumDecrypt(vault.deriveChromiumKey(password), raw)).toBe('{"keychain":"x"}')
    expect(vault.readSecret('claude-code', 'box')).toBe('{"keychain":"x"}')
    // The same password under chromiumKey reads the same blob: one vault, two readers.
    vault.useFixedChromiumKey('Shared Item', vault.deriveChromiumKey(password))
    configure({ dataDir, fetch: noFetch, secrets: { mode: 'chromiumKey', keychainItem: 'Shared Item' } })
    expect(vault.readSecret('claude-code', 'box')).toBe('{"keychain":"x"}')
  })

  it('keeps one key across restarts, honours an explicit path, and refuses an empty key file', () => {
    const { dataDir, cleanup: c } = tempCore()
    cleanup = c
    const path = join(dataDir, 'keys', 'own.key')
    configure({ dataDir, fetch: noFetch, secrets: { mode: 'fileKey', path } })
    vault.resetKeyCache()
    vault.saveSecret('codex', 'a', 'one')
    expect(statSync(join(dataDir, 'keys')).mode & 0o777).toBe(0o700)
    const first = readFileSync(path, 'utf8')
    vault.resetKeyCache()
    expect(vault.readSecret('codex', 'a')).toBe('one')
    expect(readFileSync(path, 'utf8')).toBe(first)
    vault.resetKeyCache()
    const { writeFileSync } = require('node:fs') as typeof import('node:fs')
    writeFileSync(path, '')
    expect(() => vault.readSecret('codex', 'a')).toThrow(/is empty/)
  })
})
