import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configure, type CoreConfig, type Fetch } from '../src/config'
import { randomChromiumKey, useFixedChromiumKey } from '../src/vault'

export const noFetch: Fetch = async (url) => {
  throw new Error(`unexpected fetch ${url}`)
}

/** A throwaway data dir with the vault sealed by a fixed key. */
export function tempCore(overrides: Partial<CoreConfig> = {}): { dataDir: string; cleanup: () => void } {
  const dataDir = mkdtempSync(join(tmpdir(), 'aliax-core-'))
  configure({
    dataDir,
    fetch: noFetch,
    secrets: { mode: 'chromiumKey', keychainItem: 'Test Safe Storage' },
    ...overrides
  })
  useFixedChromiumKey('Test Safe Storage', randomChromiumKey())
  return { dataDir, cleanup: () => rmSync(dataDir, { recursive: true, force: true }) }
}

export const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
