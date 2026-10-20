import type { ServiceId } from './shared/types'

/**
 * One asynchronous lock per stored profile, shared by everything that may
 * change which host refreshes a grant: a token refresh (refresh.ts), a
 * handoff to another environment and the landing of one (sync.ts). Holding
 * it across a network round trip is the point: a refresh that started before
 * a handoff finishes before the handoff reads the vault, and a refresh that
 * arrives during one waits until ownership is settled, then re-reads the
 * profile. Different profiles hold different grants and never wait on each
 * other.
 */
const tails = new Map<string, Promise<void>>()

export const lockKey = (serviceId: ServiceId, name: string): string => `${serviceId}:${name}`

/** Wait for the lock, then hold it until the returned release runs. Always release in a finally. */
export function acquire(serviceId: ServiceId, name: string): Promise<() => void> {
  const key = lockKey(serviceId, name)
  const prior = tails.get(key) ?? Promise.resolve()
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = () => {
      resolve()
      if (tails.get(key) === held) tails.delete(key)
    }
  })
  tails.set(key, held)
  return prior.then(() => release)
}

/** Run `work` under the profile's lock. */
export async function withLock<T>(serviceId: ServiceId, name: string, work: () => Promise<T>): Promise<T> {
  const release = await acquire(serviceId, name)
  try {
    return await work()
  } finally {
    release()
  }
}

/** Whether something holds or waits for the profile's lock right now (tests and diagnostics). */
export const isLocked = (serviceId: ServiceId, name: string): boolean => tails.has(lockKey(serviceId, name))
