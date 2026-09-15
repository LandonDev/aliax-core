import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Write through a temp file and rename, so a reader in the other app never
 * sees a half-written JSON file. Two apps share this vault.
 */
export function writeAtomic(path: string, data: string | Buffer, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, data, { mode })
  renameSync(tmp, path)
}
