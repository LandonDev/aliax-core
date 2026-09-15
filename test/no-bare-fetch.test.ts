import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : []
  })
}

describe('no bare fetch', () => {
  it('every provider call goes through the injected fetch', () => {
    const offenders: string[] = []
    for (const f of files('src')) {
      if (f.endsWith('config.ts')) continue
      const src = readFileSync(f, 'utf8')
      const usesFetch = /\bfetch\(/.test(src)
      const importsInjected = /import \{[^}]*\bfetch\b[^}]*\} from '\.{1,2}\/config'/.test(src)
      if (usesFetch && !importsInjected) offenders.push(f)
      if (/\bnet\.fetch|from 'electron'/.test(src)) offenders.push(f)
    }
    expect(offenders).toEqual([])
  })
})
