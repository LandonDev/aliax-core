import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { codex, codexDir } from '../src/adapters/codex'

const jwt = (claims: Record<string, unknown>): string => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`
const authJson = (refresh: string | null, accountId = 'acct-1'): string =>
  JSON.stringify({ tokens: { access_token: jwt({ exp: 1 }), ...(refresh ? { refresh_token: refresh } : {}), id_token: jwt({ email: 'a@x' }), account_id: accountId }, last_refresh: 'now' })

let home = ''
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'codex-home-'))
  process.env.CODEX_HOME = home
})
afterEach(() => {
  delete process.env.CODEX_HOME
  rmSync(home, { recursive: true, force: true })
})

describe('the Codex grant lineage', () => {
  it('fingerprints the refresh token of auth.json and of a stored blob the same way, never the token itself', async () => {
    expect(codexDir()).toBe(home)
    expect(await codex.liveFingerprint!()).toBeNull()
    writeFileSync(join(home, 'auth.json'), authJson('refresh-secret'))
    const live = await codex.liveFingerprint!()
    expect(live).toMatch(/^[0-9a-f]{64}$/)
    expect(live).not.toContain('refresh-secret')
    expect(codex.fingerprintOf!(authJson('refresh-secret'))).toBe(live)
    expect(codex.fingerprintOf!(authJson('refresh-secret', 'acct-2'))).toBe(live)
    // The CLI rotated: the stored blob is no longer the live grant.
    writeFileSync(join(home, 'auth.json'), authJson('refresh-rotated'))
    expect(await codex.liveFingerprint!()).not.toBe(live)
    expect(await codex.liveAccountId()).toBe('acct-1')
  })

  it('a blob with no refresh token, an API key or garbage has no lineage', async () => {
    expect(codex.fingerprintOf!(authJson(null))).toBeNull()
    expect(codex.fingerprintOf!(JSON.stringify({ OPENAI_API_KEY: 'k' }))).toBeNull()
    expect(codex.fingerprintOf!('nope')).toBeNull()
    writeFileSync(join(home, 'auth.json'), 'not json')
    expect(await codex.liveFingerprint!()).toBeNull()
  })
})
