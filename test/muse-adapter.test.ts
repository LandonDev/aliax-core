import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { adapterForTest, observeWindows, usageOf } from '../src/accounts'
import { MUSE_LOGGED_OUT, USAGE_NOTE, muse, museAccountId, museAuthOf, museAuthPath, museConfigDir, museFingerprint } from '../src/adapters/muse'
import * as vault from '../src/vault'
import { tempCore } from './helpers'

let cleanup = (): void => {}
const savedXdg = process.env.XDG_CONFIG_HOME
afterEach(() => {
  cleanup()
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = savedXdg
})

const CRED = {
  schema_version: 1,
  providers: {
    meta: {
      access_token: 'dca:' + 'a'.repeat(280),
      obtained_via: 'device_code',
      mechanism: 'oauth',
      api_key: 'LLM|28|' + 'k'.repeat(40),
      api_base_url: 'https://api.meta.ai/v1',
      subs_active: true,
      user_full_name: 'Landon Hale',
      user_email: 'Landon@Example.com'
    }
  }
}
const text = JSON.stringify(CRED, null, 2) + '\n'

function scratch(): string {
  const { dataDir, cleanup: c } = tempCore()
  cleanup = c
  process.env.XDG_CONFIG_HOME = join(dataDir, 'xdg')
  return dataDir
}

describe('the muse-code adapter', () => {
  it('reads its login under XDG_CONFIG_HOME, identifies by the email, fingerprints the secrets', async () => {
    scratch()
    expect(museConfigDir()).toBe(join(process.env.XDG_CONFIG_HOME!, 'muse'))
    expect(museAuthPath()).toBe(join(museConfigDir(), 'auth.json'))
    expect(museAuthOf(text)!.user_email).toBe('Landon@Example.com')
    expect(museAccountId(museAuthOf(text)!)).toBe('landon@example.com')
    expect(museAccountId({ api_key: 'LLM|1|x' })).toMatch(/^key-[0-9a-f]{12}$/)
    expect(museAuthOf(MUSE_LOGGED_OUT)).toBeNull()
    expect(museAuthOf('nope')).toBeNull()
    expect(museFingerprint(text)).toMatch(/^[0-9a-f]{16}$/)
    expect(museFingerprint(MUSE_LOGGED_OUT)).toBeNull()
    expect(await muse.identify!(text)).toEqual({ accountId: 'landon@example.com', email: 'Landon@Example.com' })
    expect(await muse.identify!(MUSE_LOGGED_OUT)).toBeNull()
    expect(muse.supportsLogin).toBe(false)
    expect(muse.targets).toEqual([])
    expect(adapterForTest('muse-code')).toBe(muse)
  })

  it('captures the live file whole, activates it back 0600 by rename, and null logs out', async () => {
    scratch()
    expect(await muse.liveAccountId()).toBeNull()
    await expect(muse.capture(() => '')).rejects.toThrow(/run `muse login` first/)
    mkdirSync(museConfigDir(), { recursive: true })
    writeFileSync(museAuthPath(), text)
    expect(await muse.liveAccountId()).toBe('landon@example.com')
    expect(await muse.liveFingerprint!()).toBe(museFingerprint(text))
    const captured = await muse.capture(() => '')
    expect(captured).toEqual({ accountId: 'landon@example.com', email: 'Landon@Example.com', blob: text })

    const other = text.replace('Landon@Example.com', 'other@example.com')
    chmodSync(museAuthPath(), 0o644)
    expect(await muse.activate(other, () => '', new Set())).toEqual([])
    expect(readFileSync(museAuthPath(), 'utf8')).toBe(other)
    expect(statSync(museAuthPath()).mode & 0o777).toBe(0o600)
    expect(await muse.liveAccountId()).toBe('other@example.com')
    expect(existsSync(`${museAuthPath()}.${process.pid}.tmp`)).toBe(false)

    expect(await muse.activate(null, () => '', new Set())).toEqual([])
    expect(existsSync(museAuthPath())).toBe(false)
    expect(await muse.activate(null, () => '', new Set())).toEqual([])
  })

  it('detects an install by the config dir or the binary', () => {
    const dir = scratch()
    const savedPath = process.env.PATH
    try {
      process.env.PATH = join(dir, 'nowhere')
      expect(muse.detect()).toBe(false)
      mkdirSync(join(dir, 'bin'))
      writeFileSync(join(dir, 'bin', 'muse'), '')
      process.env.PATH = join(dir, 'bin')
      expect(muse.detect()).toBe(true)
      process.env.PATH = join(dir, 'nowhere')
      mkdirSync(museConfigDir(), { recursive: true })
      expect(muse.detect()).toBe(true)
    } finally {
      process.env.PATH = savedPath
    }
  })

  it('usage is unsettled with its note, so a poll keeps the windows a session observed; a logged-out blob is expired', async () => {
    scratch()
    expect(await muse.usage(text, false)).toEqual({ windows: [], settled: false, note: USAGE_NOTE })
    expect(await muse.usage(MUSE_LOGGED_OUT, false)).toEqual({ windows: [], settled: true, expired: true, note: 'logged out' })
    expect(await muse.usage(text.replace('"subs_active": true', '"subs_active": false'), false)).toMatchObject({ settled: true, note: 'subscription inactive' })

    vault.upsertProfile('muse-code', { name: 'landon@example.com', accountId: 'landon@example.com', createdAt: 1, static: true })
    vault.saveSecret('muse-code', 'landon@example.com', text)
    const observed = observeWindows('muse-code', 'landon@example.com', [
      { label: '5h', usedPercent: 42, resetsAt: 1_800_000_000_000, periodMs: 18_000_000 },
      { label: 'Weekly', usedPercent: 7, resetsAt: 1_800_600_000_000 }
    ])
    expect(observed?.windows.map((w) => [w.label, w.usedPercent])).toEqual([['5h', 42], ['Weekly', 7]])
    const polled = await usageOf('muse-code', 'landon@example.com', true)
    expect(polled?.windows.map((w) => [w.label, w.usedPercent])).toEqual([['5h', 42], ['Weekly', 7]])
  })
})
