import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { FEATURES, handleControl } from '../src/gateway/control'
import { tempCore } from './helpers'

let cleanup = (): void => {}
let server: Server | null = null
afterEach(async () => {
  cleanup()
  if (server) await new Promise((r) => server!.close(r))
  server = null
})

describe('control', () => {
  it('the liveness answer lists the gateway features so a host can probe for scoped routes', async () => {
    cleanup = tempCore().cleanup
    server = createServer((req, res) => void handleControl(req, res, { pid: process.pid, url: 'http://127.0.0.1:0', at: 0 } as never))
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port
    const body = await (await fetch(`http://127.0.0.1:${port}/__aliax`)).json()
    expect(body).toMatchObject({ ok: true, pid: process.pid, features: ['scoped-routes'] })
    expect(FEATURES).toContain('scoped-routes')
    // Through the shim only service paths get forwarded: the same answer under a prefix.
    expect(await (await fetch(`http://127.0.0.1:${port}/claude/__aliax`)).json()).toMatchObject({ features: ['scoped-routes'] })
    expect(await (await fetch(`http://127.0.0.1:${port}/codex/__aliax`)).json()).toMatchObject({ ok: true })
  })
})
