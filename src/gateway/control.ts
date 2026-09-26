import type { IncomingMessage, ServerResponse } from 'node:http'
import * as accounts from '../accounts'
import type { ServiceId } from '../shared/types'
import type { Owner } from './marker'

/**
 * The gateway's own endpoints, answered by whichever app owns the marker:
 *   GET /__aliax                       liveness: { ok, pid, owner, features }
 *   GET /__aliax/usage?service=<id>[&force=1]
 *                                      poll (or serve) usage for one service;
 *                                      a standby forwards its Refresh here so
 *                                      one poller writes the shared cache.
 * Both also answer under a service prefix (`/claude/__aliax`), the only
 * paths the shim forwards, so a host can probe the owner through it.
 * Returns false when the path is not a control path.
 */
/**
 * What this gateway understands beyond plain forwarding, so a host in front
 * of an older owner can fall back:
 *   scoped-routes  the `~t=…;a=…` path segment (per-thread accounts)
 */
export const FEATURES = ['scoped-routes'] as const

export async function handleControl(
  req: IncomingMessage,
  res: ServerResponse,
  owner: Owner
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  url.pathname = url.pathname.replace(/^\/(?:claude|codex)(?=\/__aliax)/, '')
  if (url.pathname === '/__aliax') {
    json(res, 200, { ok: true, pid: process.pid, owner, features: FEATURES })
    return true
  }
  if (url.pathname === '/__aliax/usage') {
    const service = url.searchParams.get('service') as ServiceId | null
    if (!service) {
      json(res, 400, { error: 'service required' })
      return true
    }
    try {
      const reports = await accounts.usage(service, url.searchParams.get('force') === '1')
      json(res, 200, { reports })
    } catch (e) {
      json(res, 500, { error: (e as Error).message })
    }
    return true
  }
  return false
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
