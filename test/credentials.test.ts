import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claude, liveKeychain } from '../src/adapters/claude'
import {
  CLAUDE_CREDENTIALS_SERVICE,
  claudeCredentialsPath,
  credentialBackendFor,
  credentials,
  fileBackend,
  keychainBackend,
  useCredentialBackend
} from '../src/credentials'
import { readPassword, writePassword } from '../src/keychain'

const BLOB = JSON.stringify({ claudeAiOauth: { accessToken: 'acc', refreshToken: 'ref', expiresAt: 1 } })
const BLOB2 = JSON.stringify({ claudeAiOauth: { accessToken: 'acc2', refreshToken: 'ref2', expiresAt: 2 } })

let home = ''
const tempHome = (): string => (home = mkdtempSync(join(tmpdir(), 'aliax-cred-')))
const claudeFile = (): string => join(home, '.claude', '.credentials.json')

afterEach(() => {
  useCredentialBackend(null)
  if (home) rmSync(home, { recursive: true, force: true })
  home = ''
})

describe('file backend (Linux)', () => {
  it('reads a missing file as nothing stored, not an error', async () => {
    const b = fileBackend({ home: tempHome(), env: {} })
    await expect(b.read(CLAUDE_CREDENTIALS_SERVICE)).resolves.toBeNull()
    expect(existsSync(join(home, '.claude'))).toBe(false)
  })

  it('round-trips the blob through ~/.claude/.credentials.json with mode 0600 in a 0700 dir', async () => {
    const b = fileBackend({ home: tempHome(), env: {} })
    await b.write(CLAUDE_CREDENTIALS_SERVICE, 'me', BLOB)
    expect(readFileSync(claudeFile(), 'utf8')).toBe(BLOB)
    expect(statSync(claudeFile()).mode & 0o777).toBe(0o600)
    expect(statSync(join(home, '.claude')).mode & 0o777).toBe(0o700)
    await expect(b.read(CLAUDE_CREDENTIALS_SERVICE)).resolves.toBe(BLOB)
    expect(JSON.parse((await b.read(CLAUDE_CREDENTIALS_SERVICE))!).claudeAiOauth.accessToken).toBe('acc')
  })

  it('follows CLAUDE_CONFIG_DIR', async () => {
    const dir = join(tempHome(), 'cfg')
    expect(claudeCredentialsPath({ CLAUDE_CONFIG_DIR: dir }, home)).toBe(join(dir, '.credentials.json'))
    expect(claudeCredentialsPath({}, home)).toBe(claudeFile())
    const b = fileBackend({ home, env: { CLAUDE_CONFIG_DIR: dir } })
    await b.write(CLAUDE_CREDENTIALS_SERVICE, 'me', BLOB)
    expect(readFileSync(join(dir, '.credentials.json'), 'utf8')).toBe(BLOB)
    expect(existsSync(claudeFile())).toBe(false)
  })

  it('refuses a value that is not JSON and leaves the file exactly as it was', async () => {
    const b = fileBackend({ home: tempHome(), env: {} })
    await b.write(CLAUDE_CREDENTIALS_SERVICE, 'me', BLOB)
    await expect(b.write(CLAUDE_CREDENTIALS_SERVICE, 'me', '{"claudeAiOauth":')).rejects.toThrow(/not JSON/)
    expect(readFileSync(claudeFile(), 'utf8')).toBe(BLOB)
    expect(readdirSync(join(home, '.claude'))).toEqual(['.credentials.json'])
  })

  it('replaces the file whole through a rename and leaves no temp file', async () => {
    const b = fileBackend({ home: tempHome(), env: {} })
    await b.write(CLAUDE_CREDENTIALS_SERVICE, 'me', BLOB)
    const before = statSync(claudeFile()).ino
    await b.write(CLAUDE_CREDENTIALS_SERVICE, 'me', BLOB2)
    expect(statSync(claudeFile()).ino).not.toBe(before)
    expect(readFileSync(claudeFile(), 'utf8')).toBe(BLOB2)
    expect(readdirSync(join(home, '.claude'))).toEqual(['.credentials.json'])
  })

  it('treats an empty file as nothing stored', async () => {
    const b = fileBackend({ home: tempHome(), env: {} })
    await b.write(CLAUDE_CREDENTIALS_SERVICE, 'me', BLOB)
    rmSync(claudeFile())
    await b.write(CLAUDE_CREDENTIALS_SERVICE, 'me', '{}')
    expect(await b.read(CLAUDE_CREDENTIALS_SERVICE)).toBe('{}')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(claudeFile(), '  \n')
    await expect(b.read(CLAUDE_CREDENTIALS_SERVICE)).resolves.toBeNull()
  })

  it('names the services it has no file for instead of inventing one', async () => {
    const b = fileBackend({ home: tempHome(), env: {} })
    await expect(b.read('cursor-access-token')).rejects.toThrow(/no credentials file for "cursor-access-token"/)
    await expect(b.write('cursor-access-token', 'cursor-user', 'jwt')).rejects.toThrow(/cursor-access-token/)
    expect(readdirSync(home)).toEqual([])
  })
})

describe('keychain backend (macOS)', () => {
  it('reads and writes through the security tool with the original arguments', async () => {
    const exec = vi.fn(async (_file: string, args: string[]) => ({
      stdout: args[0] === 'find-generic-password' ? `${BLOB}\n` : ''
    }))
    const b = keychainBackend(exec)
    await expect(b.read(CLAUDE_CREDENTIALS_SERVICE)).resolves.toBe(BLOB)
    expect(exec).toHaveBeenCalledWith('security', ['find-generic-password', '-s', CLAUDE_CREDENTIALS_SERVICE, '-w'])
    await b.write(CLAUDE_CREDENTIALS_SERVICE, 'landon', BLOB)
    expect(exec).toHaveBeenCalledWith('security', [
      'add-generic-password',
      '-U',
      '-s',
      CLAUDE_CREDENTIALS_SERVICE,
      '-a',
      'landon',
      '-w',
      BLOB
    ])
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('reads exit 44 (no such item) as nothing stored and rethrows anything else', async () => {
    const missing = Object.assign(new Error('could not be found'), { code: 44 })
    await expect(
      keychainBackend(async () => {
        throw missing
      }).read('x')
    ).resolves.toBeNull()
    const denied = Object.assign(new Error('user canceled'), { code: 128 })
    await expect(
      keychainBackend(async () => {
        throw denied
      }).read('x')
    ).rejects.toBe(denied)
  })
})

describe('platform selection and the legacy calls', () => {
  it('picks the Keychain on darwin and files everywhere else', () => {
    expect(credentialBackendFor('darwin').kind).toBe('keychain')
    expect(credentialBackendFor('linux').kind).toBe('file')
    expect(credentialBackendFor('win32').kind).toBe('file')
    expect(credentialBackendFor().kind).toBe(process.platform === 'darwin' ? 'keychain' : 'file')
  })

  it('readPassword still throws on nothing stored; the seam routes both calls', async () => {
    const store = new Map<string, string>()
    useCredentialBackend({
      kind: 'file',
      read: async (s) => store.get(s) ?? null,
      write: async (s, _a, v) => void store.set(s, v)
    })
    expect(credentials().kind).toBe('file')
    await expect(readPassword(CLAUDE_CREDENTIALS_SERVICE)).rejects.toThrow(/not signed in/)
    await writePassword(CLAUDE_CREDENTIALS_SERVICE, 'me', BLOB)
    await expect(readPassword(CLAUDE_CREDENTIALS_SERVICE)).resolves.toBe(BLOB)
    useCredentialBackend(null)
    expect(credentials().kind).toBe(credentialBackendFor().kind)
  })
})

describe('claude adapter over the file backend', () => {
  it('says no tokens for a missing file and parses the same shape once it exists', async () => {
    const b = fileBackend({ home: tempHome(), env: {} })
    useCredentialBackend(b)
    await expect(liveKeychain()).resolves.toBeNull()
    await expect(claude.liveFingerprint!()).resolves.toBeNull()
    await expect(claude.liveCredentialExpired!()).resolves.toBe(false)
    await b.write(CLAUDE_CREDENTIALS_SERVICE, 'me', BLOB)
    await expect(liveKeychain()).resolves.toBe(BLOB)
    await expect(claude.liveFingerprint!()).resolves.toBe(createHash('sha256').update('ref').digest('hex'))
    await expect(claude.liveCredentialExpired!()).resolves.toBe(true)
  })
})
