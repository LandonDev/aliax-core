import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataDir } from './config'
import { writeAtomic } from './fs'
import type { ServiceId, Settings } from './shared/types'

const DEFAULTS: Settings = { windowMode: 'normal', switchTargets: {} }

export const settingsPath = (): string => join(dataDir(), 'settings.json')

export function getSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(settingsPath(), 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveSettings(settings: Settings): void {
  writeAtomic(settingsPath(), JSON.stringify(settings, null, 2), 0o644)
}

/** Enabled switch targets for a service; targets default to on unless toggled off. */
export function enabledTargets(serviceId: ServiceId, allTargets: { id: string }[]): Set<string> {
  const overrides = getSettings().switchTargets[serviceId] ?? {}
  return new Set(allTargets.filter((t) => overrides[t.id] !== false).map((t) => t.id))
}

/**
 * The account each service should be using right now. Set explicitly by a
 * switch so a CLI writing its own refreshed tokens back to disk (Claude Code
 * does this) can never drag a proxied session back to the old account. Read
 * from disk per request: the other app may have moved the pin.
 */
export function pinnedProfile(serviceId: ServiceId): string | null {
  return getSettings().proxyAccounts?.[serviceId] ?? null
}

export function pinProfile(serviceId: ServiceId, name: string | null): void {
  const settings = getSettings()
  const next = { ...(settings.proxyAccounts ?? {}) }
  if (name) next[serviceId] = name
  else delete next[serviceId]
  saveSettings({ ...settings, proxyAccounts: next })
}
