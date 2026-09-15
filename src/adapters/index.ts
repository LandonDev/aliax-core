import type { ServiceId } from '../shared/types'
import { claude } from './claude'
import { codex } from './codex'
import { cursor } from './cursor'
import type { Adapter } from './types'

export const adapters: Adapter[] = [claude, codex, cursor]

export function adapter(id: ServiceId): Adapter {
  const found = adapters.find((a) => a.id === id)
  if (!found) throw new Error(`unknown service: ${id}`)
  return found
}
