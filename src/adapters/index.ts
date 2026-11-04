import type { ServiceId } from '../shared/types'
import { claude } from './claude'
import { codex } from './codex'
import { cursor } from './cursor'
import { meta } from './meta'
import type { Adapter } from './types'

export const adapters: Adapter[] = [claude, codex, cursor, meta]

export function adapter(id: ServiceId): Adapter {
  const found = adapters.find((a) => a.id === id)
  if (!found) throw new Error(`unknown service: ${id}`)
  return found
}
