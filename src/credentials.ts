import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { writeAtomic } from './fs'

/**
 * Where a CLI keeps the secret it is signed in with.
 *
 * On macOS every CLI here uses the login Keychain: Claude Code holds one
 * generic-password item whose value is a JSON blob, Cursor holds two. On Linux
 * the same programs keep the same bytes in plain files with mode 0600: Claude
 * Code writes `$CLAUDE_CONFIG_DIR/.credentials.json` (default
 * `~/.claude/.credentials.json`) holding the identical `{ claudeAiOauth: {…} }`
 * object its Keychain item holds on a Mac, and rereads it whenever its mtime
 * moves. The adapters parse one shape either way; only the store differs, so
 * the store is the one thing that switches on the platform.
 */
export interface CredentialBackend {
  readonly kind: 'keychain' | 'file'
  /** The stored secret, or null when nothing is stored under the service. */
  read(service: string): Promise<string | null>
  write(service: string, account: string, value: string): Promise<void>
}

export type Exec = (file: string, args: string[]) => Promise<{ stdout: string }>
const defaultExec: Exec = promisify(execFile)

/** `security` exits 44 (errSecItemNotFound) when no item matches. */
const SEC_ITEM_NOT_FOUND = 44

/** The macOS login Keychain, through the `security` tool, exactly as before. */
export function keychainBackend(exec: Exec = defaultExec): CredentialBackend {
  return {
    kind: 'keychain',
    async read(service) {
      try {
        const { stdout } = await exec('security', ['find-generic-password', '-s', service, '-w'])
        return stdout.replace(/\n$/, '')
      } catch (e) {
        if ((e as { code?: unknown }).code === SEC_ITEM_NOT_FOUND) return null
        throw e
      }
    },
    async write(service, account, value) {
      await exec('security', ['add-generic-password', '-U', '-s', service, '-a', account, '-w', value])
    }
  }
}

/** The Keychain service Claude Code stores its OAuth blob under. */
export const CLAUDE_CREDENTIALS_SERVICE = 'Claude Code-credentials'

/** Claude Code's credentials file off macOS: `$CLAUDE_CONFIG_DIR/.credentials.json`, else `~/.claude/.credentials.json`. */
export function claudeCredentialsPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), '.credentials.json')
}

export interface FileBackendOptions {
  home?: string
  env?: NodeJS.ProcessEnv
}

/**
 * Plain files, one per service, where the CLI itself keeps them. Only services
 * with a known file are served: Cursor's IDE tokens live in its own secret
 * store on Linux, which nothing here can read, so asking for them says so
 * instead of inventing a file no program reads.
 */
export function fileBackend(opts: FileBackendOptions = {}): CredentialBackend {
  const home = opts.home ?? homedir()
  const env = opts.env ?? process.env
  const pathOf = (service: string): string => {
    if (service === CLAUDE_CREDENTIALS_SERVICE) return claudeCredentialsPath(env, home)
    throw new Error(`no credentials file for "${service}" on ${process.platform}`)
  }
  return {
    kind: 'file',
    async read(service) {
      try {
        const text = readFileSync(pathOf(service), 'utf8')
        return text.trim() ? text : null
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw e
      }
    },
    async write(service, _account, value) {
      const path = pathOf(service)
      // The CLI parses this file whole on every read, so a non-JSON or
      // half-written file signs the user out. Refuse what does not parse
      // (the file on disk stays as it was), and land the rest through a temp
      // file and rename, so no reader ever sees a partial file.
      try {
        JSON.parse(value)
      } catch {
        throw new Error(`refusing to write ${path}: value is not JSON`)
      }
      writeAtomic(path, value, 0o600)
    }
  }
}

/**
 * The platform's own store, except that `ALIAX_CREDENTIAL_BACKEND=file`
 * makes a macOS process use the credentials file too: an isolated
 * instance under test points CLAUDE_CONFIG_DIR into its own data and never
 * reads or writes the user's Keychain item.
 */
export function credentialBackendFor(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): CredentialBackend {
  if (env.ALIAX_CREDENTIAL_BACKEND === 'file') return fileBackend()
  return platform === 'darwin' ? keychainBackend() : fileBackend()
}

let platformBackend: CredentialBackend | null = null
let override: CredentialBackend | null = null

/** Test seam: route every read and write through this backend; null restores the platform's own. */
export function useCredentialBackend(backend: CredentialBackend | null): void {
  override = backend
}

export function credentials(): CredentialBackend {
  return override ?? (platformBackend ??= credentialBackendFor())
}
