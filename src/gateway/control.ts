import type { IncomingMessage, ServerResponse } from 'node:http'
import * as accounts from '../accounts'
import type { ServiceId } from '../shared/types'
import type { Owner } from './marker'

/**
 * The gateway's own endpoints, answered by whichever app owns the marker:
 *   GET /__aliax                       liveness: { ok, pid, owner }
 *   GET /__aliax/usage?service=<id>[&force=1]
 *                                      poll (or serve) usage for one service;
 *                                      a standby forwards its Refresh here so
 *                                      one poller writes the shared cache.
 * Returns false when the path is not a control path.
 */
export async function handleControl(
  req: IncomingMessage,
  res: ServerResponse,
  owner: Owner
): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/__aliax') {
    json(res, 200, { ok: true, pid: process.pid, owner })
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
