import { existsSync, mkdirSync, readFileSync, rmSync, watch, type FSWatcher } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeAtomic } from '../fs'

/** Where the shim, the shell snippet and both apps look for the live gateway. */
export const RUNTIME_DIR = join(homedir(), '.aliax')
export const MARKER_PATH = join(RUNTIME_DIR, 'proxy.json')

export type Owner = 'aliax' | 'temp-code'

export interface Marker {
  port: number
  pid: number
  url: string
  owner: Owner
  claimedAt: number
  /** The gateway this one took over from, restored on release if still alive. */
  previous?: Pick<Marker, 'port' | 'pid' | 'url' | 'owner'>
}

export function readMarker(): Marker | null {
  try {
    const m = JSON.parse(readFileSync(MARKER_PATH, 'utf8'))
    if (typeof m?.port !== 'number' || typeof m?.pid !== 'number') return null
    // Markers from before ownership existed came from Aliax.
    return { owner: 'aliax', claimedAt: 0, url: `http://127.0.0.1:${m.port}`, ...m }
  } catch {
    return null
  }
}

export function pidAlive(pid: number): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** A marker whose process still runs. Everything else is stale. */
export const isLive = (m: Marker | null): m is Marker => m !== null && pidAlive(m.pid)

/**
 * Write ourselves as the gateway. When another live process holds the marker
 * (a foreign app, or a second copy of this one, such as a dev run beside the
 * installed app) we remember it as `previous`, so releasing hands the shim
 * back to it.
 */
export function claim(owner: Owner, port: number): Marker {
  const current = readMarker()
  const previous =
    isLive(current) && current.pid !== process.pid
      ? { port: current.port, pid: current.pid, url: current.url, owner: current.owner }
      : current?.pid === process.pid
        ? current.previous
        : undefined
  const marker: Marker = {
    port,
    pid: process.pid,
    url: `http://127.0.0.1:${port}`,
    owner,
    claimedAt: Date.now(),
    ...(previous && pidAlive(previous.pid) ? { previous } : {})
  }
  mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 })
  writeAtomic(MARKER_PATH, JSON.stringify(marker, null, 2))
  return marker
}

/**
 * Give the marker back. Only our own marker is ever touched: if something
 * else claimed since, it is theirs. A still-alive `previous` gets restored,
 * so quitting temp-code returns the shim to a running Aliax.
 */
export function release(owner: Owner): void {
  const current = readMarker()
  if (!current || current.owner !== owner || current.pid !== process.pid) return
  const prev = current.previous
  if (prev && pidAlive(prev.pid)) {
    writeAtomic(
      MARKER_PATH,
      JSON.stringify({ ...prev, claimedAt: Date.now() } satisfies Marker, null, 2)
    )
    return
  }
  rmSync(MARKER_PATH, { force: true })
}

/**
 * One non-recursive watch on ~/.aliax, debounced, plus a slow liveness tick:
 * a crashed owner never writes a change event, so the tick is what notices
 * its pid is gone. Returns a stop function.
 */
export function watchMarker(
  onChange: () => void,
  { debounceMs = 200, tickMs = 30_000 }: { debounceMs?: number; tickMs?: number } = {}
): () => void {
  mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 })
  let timer: NodeJS.Timeout | null = null
  const fire = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      onChange()
    }, debounceMs)
  }
  let watcher: FSWatcher | null = null
  try {
    watcher = watch(RUNTIME_DIR, (_event, file) => {
      if (!file || file === 'proxy.json' || file.startsWith('proxy.json.')) fire()
    })
    watcher.on('error', () => {})
  } catch {
    // no watcher: the tick still runs
  }
  const tick = setInterval(onChange, tickMs)
  tick.unref?.()
  return () => {
    if (timer) clearTimeout(timer)
    clearInterval(tick)
    watcher?.close()
  }
}

export const markerExists = (): boolean => existsSync(MARKER_PATH)
