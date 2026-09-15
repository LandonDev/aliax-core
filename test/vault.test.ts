import { readFileSync } from 'node:fs'
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
