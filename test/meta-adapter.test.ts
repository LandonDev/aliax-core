import { afterEach, describe, expect, it, vi } from 'vitest'
import { adapterForTest, isMetaKeyShape, listServices, saveApiKey } from '../src/accounts'
import { META_ORIGIN, meta, metaAccountId, metaBlob, metaKeyOf } from '../src/adapters/meta'
import * as vault from '../src/vault'
import { tempCore } from './helpers'

let cleanup = (): void => {}
afterEach(() => cleanup())

const MODELS_URL = `${META_ORIGIN}/v1/models`
const KEY = 'LLM_1607123_aBcDeFgHiJkLmNoPqRsTuVwXyZ'
const answering = (status: number, headers: Record<string, string> = {}) =>
  vi.fn(async (url: string, init?: RequestInit) => {
    if (url !== MODELS_URL) throw new Error(`unexpected fetch ${url}`)
    expect((init!.headers as Record<string, string>).Authorization).toMatch(/^Bearer LLM_\d+_/)
    return new Response(status === 200 ? '{"data":[{"id":"muse-wonder-1.0"}]}' : '{"error":{"message":"no"}}', { status, headers })
  })

describe('the meta adapter', () => {
  it('is always installed, has no sign-in, no live credential, no switch and no targets', async () => {
    cleanup = tempCore().cleanup
    expect(meta.detect()).toBe(true)
    expect(meta.supportsLogin).toBe(false)
    expect(meta.targets).toEqual([])
    expect(await meta.liveAccountId()).toBeNull()
    await expect(meta.capture(() => '')).rejects.toThrow(/add a key instead/)
    expect(await meta.activate(metaBlob(KEY), () => '', new Set())).toEqual([])
    expect(adapterForTest('meta')).toBe(meta)
  })

  it('identifies a key by the numeric id inside it', async () => {
    expect(metaAccountId(KEY)).toBe('1607123')
    expect(metaAccountId(' LLM_42_x ')).toBe('42')
    expect(metaAccountId('sk-ant-123')).toBeNull()
    expect(metaAccountId('LLM_abc_x')).toBeNull()
    expect(metaKeyOf(metaBlob(` ${KEY} `))).toBe(KEY)
    expect(metaKeyOf('nope')).toBeNull()
    expect(await meta.identify!(metaBlob(KEY))).toEqual({ accountId: '1607123' })
    expect(await meta.identify!('{}')).toBeNull()
    expect(isMetaKeyShape(KEY)).toBe(true)
    expect(isMetaKeyShape('LLM_')).toBe(false)
  })

  it('usage is a probe of /v1/models: pay as you go on 200, revoked on 401 or 403, a throttle with its Retry-After, else the status', async () => {
    const run = async (status: number, headers?: Record<string, string>) => {
      cleanup()
      const fetch = answering(status, headers)
      cleanup = tempCore({ fetch }).cleanup
      return meta.usage(metaBlob(KEY), false)
    }
    expect(await run(200)).toEqual({ windows: [], settled: true, note: 'pay as you go' })
    expect(await run(401)).toEqual({ windows: [], settled: true, expired: true, note: 'key revoked' })
    expect(await run(403)).toEqual({ windows: [], settled: true, expired: true, note: 'key revoked' })
    const throttled = await run(429, { 'retry-after': '7' })
    expect(throttled).toMatchObject({ windows: [], note: 'usage temporarily unavailable' })
    expect(throttled.retryAfterMs).toBeGreaterThan(6_000)
    expect(await run(503)).toEqual({ windows: [], note: 'usage unavailable (503)' })
    cleanup()
    cleanup = tempCore().cleanup
    expect(await meta.usage('{}', false)).toEqual({ windows: [], settled: true, note: 'no key saved' })
  })
})

describe('saveApiKey', () => {
  it('refuses a string that is not a Meta key before any network call', async () => {
    const fetch = vi.fn()
    cleanup = tempCore({ fetch }).cleanup
    await expect(saveApiKey('meta', { key: 'sk-ant-123' })).rejects.toThrow('not a Meta key: keys start with LLM_')
    expect(fetch).not.toHaveBeenCalled()
    expect(vault.profiles('meta')).toEqual([])
  })

  it('refuses a key Meta refuses, in one line, and saves nothing', async () => {
    cleanup = tempCore({ fetch: answering(401) }).cleanup
    await expect(saveApiKey('meta', { key: KEY })).rejects.toThrow('that key was refused by Meta')
    expect(vault.profiles('meta')).toEqual([])
    cleanup()
    cleanup = tempCore({
      fetch: vi.fn(async () => {
        throw new Error('ENOTFOUND api.meta.ai')
      })
    }).cleanup
    await expect(saveApiKey('meta', { key: KEY })).rejects.toThrow('Meta could not be reached: ENOTFOUND api.meta.ai')
  })

  it('saves a verified key as a static profile under its name, lists it as a key account, and the same key pasted twice is one row', async () => {
    const fetch = answering(200)
    cleanup = tempCore({ fetch }).cleanup
    expect(await saveApiKey('meta', { key: ` ${KEY} ` })).toBe('Meta key …wXyZ')
    expect(vault.profiles('meta')).toMatchObject([{ name: 'Meta key …wXyZ', accountId: '1607123', static: true }])
    expect(vault.profiles('meta')[0].owner).toBeUndefined()
    expect(vault.readSecret('meta', 'Meta key …wXyZ')).toBe(metaBlob(KEY))

    // The same account again, under a new name: the row keeps its name, the key is rewritten.
    expect(await saveApiKey('meta', { key: KEY, name: 'Team key' })).toBe('Meta key …wXyZ')
    expect(vault.profiles('meta')).toHaveLength(1)
    // A different key names its own row by the name given.
    expect(await saveApiKey('meta', { key: KEY.replace('1607123', '99'), name: 'Other team' })).toBe('Other team')
    expect(vault.profiles('meta').map((p) => p.accountId).sort()).toEqual(['1607123', '99'])

    const services = await listServices()
    const view = services.find((s) => s.id === 'meta')!
    expect(view).toMatchObject({ name: 'Meta Model API', installed: true, canAddAccount: false, switchTargets: [] })
    expect(view.profiles.map((p) => [p.name, p.kind, p.static, p.active])).toEqual([
      ['Meta key …wXyZ', 'key', true, false],
      ['Other team', 'key', true, false]
    ])
    expect(services.find((s) => s.id === 'codex')!.profiles.every((p) => p.kind === undefined)).toBe(true)
  })
})
