import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const home = mkdtempSync(join(tmpdir(), 'aliax-home-'))
const realHome = process.env.HOME
let marker: typeof import('../src/gateway/marker')

beforeAll(async () => {
  process.env.HOME = home
  marker = await import('../src/gateway/marker')
})
afterAll(() => {
  process.env.HOME = realHome
  rmSync(home, { recursive: true, force: true })
})

describe('marker', () => {
  it('claim writes ourselves; release deletes when nothing to restore', () => {
    expect(marker.readMarker()).toBeNull()
    const m = marker.claim('temp-code', 4000)
    expect(m).toMatchObject({ owner: 'temp-code', port: 4000, pid: process.pid, url: 'http://127.0.0.1:4000' })
    expect(marker.isLive(marker.readMarker())).toBe(true)
    marker.release('temp-code')
    expect(marker.readMarker()).toBeNull()
  })

  it('a bare legacy marker reads as aliax', () => {
    writeFileSync(marker.MARKER_PATH, JSON.stringify({ port: 5000, pid: process.pid, url: 'http://127.0.0.1:5000' }))
    expect(marker.readMarker()).toMatchObject({ owner: 'aliax', port: 5000 })
  })

  it('taking over a live foreign gateway remembers it and hands it back on release', () => {
    // The parent process stands in for a live Aliax.
    writeFileSync(marker.MARKER_PATH, JSON.stringify({ port: 5000, pid: process.ppid, url: 'http://127.0.0.1:5000', owner: 'aliax' }))
    const m = marker.claim('temp-code', 6000)
    expect(m.previous).toMatchObject({ owner: 'aliax', port: 5000 })
    marker.release('temp-code')
    expect(marker.readMarker()).toMatchObject({ owner: 'aliax', port: 5000 })
  })

  it('a dead previous is dropped rather than restored', () => {
    writeFileSync(marker.MARKER_PATH, JSON.stringify({ port: 5000, pid: 999_999_9, url: 'x', owner: 'aliax' }))
    expect(marker.isLive(marker.readMarker())).toBe(false)
    const m = marker.claim('temp-code', 6000)
    expect(m.previous).toBeUndefined()
    marker.release('temp-code')
    expect(marker.readMarker()).toBeNull()
  })

  it('release leaves a marker someone else claimed since', () => {
    marker.claim('temp-code', 6000)
    writeFileSync(marker.MARKER_PATH, JSON.stringify({ port: 7000, pid: process.ppid, url: 'x', owner: 'aliax', claimedAt: 1 }))
    marker.release('temp-code')
    expect(JSON.parse(readFileSync(marker.MARKER_PATH, 'utf8')).port).toBe(7000)
  })

  it('watchMarker fires on change and on tick', async () => {
    const seen: number[] = []
    const stop = marker.watchMarker(() => seen.push(Date.now()), { debounceMs: 20, tickMs: 60 })
    marker.claim('temp-code', 6000)
    await new Promise((r) => setTimeout(r, 150))
    stop()
    expect(seen.length).toBeGreaterThanOrEqual(2)
  })
})
