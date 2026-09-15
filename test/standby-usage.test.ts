import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { tempCore } from './helpers'

const home = mkdtempSync(join(tmpdir(), 'aliax-home-'))
const realHome = process.env.HOME
let accounts: typeof import('../src/accounts')
let marker: typeof import('../src/gateway/marker')
let server: Server
let hits: string[] = []
let core: ReturnType<typeof tempCore>

beforeAll(async () => {
  process.env.HOME = home
  marker = await import('../src/gateway/marker')
  accounts = await import('../src/accounts')
  server = createServer((req, res) => {
    hits.push(req.url ?? '')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ reports: [{ profileName: 'owner-polled', windows: [] }] }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  // The test file may use the real fetch; the core only ever sees the injected one.
  core = tempCore({ fetch: (u, i) => globalThis.fetch(u, i), role: () => 'standby' })
  mkdirSync(marker.RUNTIME_DIR, { recursive: true })
  // The parent process stands in for a live owner.
  writeFileSync(
    marker.MARKER_PATH,
    JSON.stringify({ port, pid: process.ppid, url: `http://127.0.0.1:${port}`, owner: 'temp-code' })
  )
})
afterAll(() => {
  server.close()
  core.cleanup()
  process.env.HOME = realHome
  rmSync(home, { recursive: true, force: true })
})

describe('standby usage', () => {
  it('a forced refresh goes to the owner and returns its reports', async () => {
    hits = []
    const reports = await accounts.usage('claude-code', true)
    expect(reports).toEqual([{ profileName: 'owner-polled', windows: [] }])
    expect(hits).toEqual(['/__aliax/usage?service=claude-code&force=1'])
  })

  it('an unforced read never leaves the machine', async () => {
    hits = []
    await accounts.usage('claude-code')
    expect(hits).toEqual([])
  })

  it('a dead owner falls back to the local path', async () => {
    hits = []
    writeFileSync(marker.MARKER_PATH, JSON.stringify({ port: 1, pid: 2 ** 22 - 1, url: 'http://127.0.0.1:1', owner: 'temp-code' }))
    expect(await accounts.usage('claude-code', true)).toEqual([])
    expect(hits).toEqual([])
  })
})
