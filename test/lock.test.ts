import { describe, expect, it } from 'vitest'
import { acquire, isLocked, withLock } from '../src/lock'

describe('the per-profile lock', () => {
  it('serialises holders of one key in order and leaves other keys alone', async () => {
    const order: string[] = []
    const releaseA = await acquire('codex', 'a')
    expect(isLocked('codex', 'a')).toBe(true)
    expect(isLocked('codex', 'b')).toBe(false)
    const second = withLock('codex', 'a', async () => {
      order.push('second')
    })
    const other = withLock('codex', 'b', async () => {
      order.push('other')
    })
    await other
    await new Promise((r) => setTimeout(r, 5))
    expect(order).toEqual(['other'])
    order.push('first')
    releaseA()
    await second
    expect(order).toEqual(['other', 'first', 'second'])
    expect(isLocked('codex', 'a')).toBe(false)
  })

  it('a release runs once, a throwing holder still releases, and a late release of an old hold does not drop a newer one', async () => {
    const release = await acquire('claude-code', 'p')
    release()
    release()
    expect(isLocked('claude-code', 'p')).toBe(false)
    await expect(
      withLock('claude-code', 'p', async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(isLocked('claude-code', 'p')).toBe(false)
    const first = await acquire('claude-code', 'p')
    const secondHeld = acquire('claude-code', 'p')
    first()
    const second = await secondHeld
    expect(isLocked('claude-code', 'p')).toBe(true)
    first()
    expect(isLocked('claude-code', 'p')).toBe(true)
    second()
    expect(isLocked('claude-code', 'p')).toBe(false)
  })
})
