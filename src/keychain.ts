import { credentials } from './credentials'

/**
 * The adapters' original two calls, now served by whichever credential
 * backend the platform selects (see credentials.ts). `readPassword` still
 * throws when nothing is stored, as the Keychain version did.
 */
export async function readPassword(service: string): Promise<string> {
  const value = await credentials().read(service)
  if (value === null) throw new Error(`no "${service}" credentials stored: not signed in`)
  return value
}

export async function writePassword(service: string, account: string, value: string): Promise<void> {
  await credentials().write(service, account, value)
}
