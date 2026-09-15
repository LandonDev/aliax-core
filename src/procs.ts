import { execFile } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

const CLAUDE_SETTINGS = join(homedir(), '.claude', 'settings.json')
/** Any loopback endpoint of ours, whatever port the proxy or shim landed on. */
const ALIAX_ENDPOINT = /127\.0\.0\.1:\d+\/claude\b/

/**
 * The base URL Claude Code will actually use. Its settings file beats the
 * environment: an `env` block in settings.json overrides an exported
 * ANTHROPIC_BASE_URL outright (verified against the CLI). Reading only the
 * process environment therefore missed every session started from a GUI app,
 * which is exactly the case instant switching exists to cover.
 */
function configuredClaudeBase(): { url: string; writtenAt: number } {
  try {
    const url = JSON.parse(readFileSync(CLAUDE_SETTINGS, 'utf8'))?.env?.ANTHROPIC_BASE_URL
    return { url: typeof url === 'string' ? url : '', writtenAt: statSync(CLAUDE_SETTINGS).mtimeMs }
  } catch {
    return { url: '', writtenAt: 0 }
  }
}

/** When a process started, so we can tell whether it read the current config. */
async function startedAt(pid: number): Promise<number | null> {
  try {
    const { stdout } = await exec('ps', ['-o', 'lstart=', '-p', String(pid)])
    const at = Date.parse(stdout.trim())
    return Number.isNaN(at) ? null : at
  } catch {
    return null
  }
}

/**
 * Is this running Claude session already sending its traffic through Aliax? It
 * counts when the process carries our endpoint itself, or when it launched
 * after the settings file that names it — a session older than that config read
 * the previous one and is not covered.
 */
export async function routedThroughAliax(pid: number): Promise<boolean> {
  if (ALIAX_ENDPOINT.test((await processEnv(pid)).ANTHROPIC_BASE_URL ?? '')) return true
  const { url, writtenAt } = configuredClaudeBase()
  if (!ALIAX_ENDPOINT.test(url)) return false
  const began = await startedAt(pid)
  // `ps` reports whole seconds, so compare at that resolution or a session
  // started moments after the write looks older than it is.
  return began !== null && began >= Math.floor(writtenAt / 1000) * 1000
}

export interface CliProcess {
  pid: number
  cwd: string | null
  /** Controlling terminal (e.g. "ttys012") — the key to restarting in place. */
  tty: string | null
}

/** Our own process ancestry — never kill the terminal session Aliax was launched from. */
async function ancestorPids(): Promise<Set<number>> {
  const set = new Set<number>()
  let pid = process.pid
  for (let i = 0; i < 20 && pid > 1; i++) {
    set.add(pid)
    try {
      const { stdout } = await exec('ps', ['-o', 'ppid=', '-p', String(pid)])
      pid = parseInt(stdout.trim(), 10)
    } catch {
      break
    }
  }
  return set
}

/**
 * Terminal-attached CLI processes with this exact name. Excludes Aliax's own ancestry
 * and processes without a TTY (e.g. helpers spawned by desktop apps).
 */
export async function cliProcesses(name: string): Promise<CliProcess[]> {
  let pids: number[]
  try {
    const { stdout } = await exec('pgrep', ['-x', name])
    pids = stdout.trim().split('\n').filter(Boolean).map(Number)
  } catch {
    return []
  }
  const ancestors = await ancestorPids()
  const procs: CliProcess[] = []
  for (const pid of pids) {
    if (ancestors.has(pid)) continue
    let tty: string | null
    try {
      const { stdout } = await exec('ps', ['-o', 'tty=', '-p', String(pid)])
      tty = stdout.trim()
      if (tty === '??' || !tty) continue
    } catch {
      continue
    }
    let cwd: string | null = null
    try {
      const { stdout } = await exec('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
      cwd = stdout.split('\n').find((l) => l.startsWith('n'))?.slice(1) ?? null
    } catch {
      // cwd unknown; still killable
    }
    procs.push({ pid, cwd, tty })
  }
  return procs
}

/**
 * Sessions of this CLI with no controlling terminal: the shape an editor gets
 * when it drives Claude through the agent SDK, which spawns the binary over
 * pipes. Nothing outside the host app can restart one, so this list is for
 * telling the user about them and nothing else. Never kill from it.
 */
export async function headlessCliProcesses(name: string): Promise<number[]> {
  let pids: number[]
  try {
    const { stdout } = await exec('pgrep', ['-x', name])
    pids = stdout.trim().split('\n').filter(Boolean).map(Number)
  } catch {
    return []
  }
  const ancestors = await ancestorPids()
  const out: number[] = []
  for (const pid of pids) {
    if (ancestors.has(pid)) continue
    try {
      const { stdout } = await exec('ps', ['-o', 'tty=', '-p', String(pid)])
      const tty = stdout.trim()
      if (tty === '??' || !tty) out.push(pid)
    } catch {
      // gone already
    }
  }
  return out
}

/**
 * Whether a running process already points at our proxy. Read from its actual
 * environment, so it reflects the session as launched rather than what the
 * current shell would do.
 */
export async function processEnv(pid: number): Promise<Record<string, string>> {
  try {
    const { stdout } = await exec('ps', ['-Eww', '-o', 'command=', '-p', String(pid)], {
      maxBuffer: 4 * 1024 * 1024
    })
    const env: Record<string, string> = {}
    for (const m of stdout.matchAll(/([A-Z_][A-Z0-9_]*)=([^\s]*)/g)) env[m[1]] = m[2]
    return env
  } catch {
    return {}
  }
}

/** Command line of a process, used to spot a per-invocation proxy override. */
export async function processCommand(pid: number): Promise<string> {
  try {
    const { stdout } = await exec('ps', ['-ww', '-o', 'command=', '-p', String(pid)], {
      maxBuffer: 4 * 1024 * 1024
    })
    return stdout.trim()
  } catch {
    return ''
  }
}

export async function killAndWait(pids: number[], timeoutMs = 5000): Promise<void> {
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // already gone
    }
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const alive = pids.some((pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    })
    if (!alive) return
    await new Promise((r) => setTimeout(r, 250))
  }
}

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** Find the Terminal.app tab attached to a tty and run the command in it. */
const TERMINAL_TTY_SCRIPT = `
on run argv
  set target to item 1 of argv
  set cmd to item 2 of argv
  if application "Terminal" is not running then return "miss"
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        try
          if (tty of t) is equal to target then
            do script cmd in t
            return "ok"
          end if
        end try
      end repeat
    end repeat
  end tell
  return "miss"
end run`

/** Same for iTerm2, whose sessions expose their tty. */
const ITERM_TTY_SCRIPT = `
on run argv
  set target to item 1 of argv
  set cmd to item 2 of argv
  if application "iTerm2" is not running then return "miss"
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          try
            if (tty of s) is equal to target then
              tell s to write text cmd
              return "ok"
            end if
          end try
        end repeat
      end repeat
    end repeat
  end tell
  return "miss"
end run`

/** Look for a tab owning this tty without touching it. */
const PROBE_SCRIPT = `
on run argv
  set target to item 1 of argv
  if application "Terminal" is running then
    tell application "Terminal"
      repeat with w in windows
        repeat with t in tabs of w
          try
            if (tty of t) is equal to target then return "ok"
          end try
        end repeat
      end repeat
    end tell
  end if
  if application "iTerm2" is running then
    tell application "iTerm2"
      repeat with w in windows
        repeat with t in tabs of w
          repeat with s in sessions of t
            try
              if (tty of s) is equal to target then return "ok"
            end try
          end repeat
        end repeat
      end repeat
    end tell
  end if
  return "miss"
end run`

/**
 * Does a scriptable terminal own this tty? Asked BEFORE anything is killed, and
 * read-only: an editor's built-in terminal must not even be written to, let
 * alone restarted somewhere else.
 */
export async function terminalOwns(tty: string | null): Promise<boolean> {
  if (!tty) return false
  try {
    const { stdout } = await exec('osascript', ['-e', PROBE_SCRIPT, `/dev/${tty}`])
    return stdout.trim() === 'ok'
  } catch {
    return false
  }
}

/**
 * Restart a killed CLI in the exact tab it lived in. There is deliberately no
 * fallback: a session Aliax cannot put back where it was must not be moved to
 * another terminal app, so callers check `terminalOwns` first and simply leave
 * anything else running.
 */
export async function reopenSession(proc: CliProcess, command: string): Promise<boolean> {
  const full = proc.cwd ? `cd ${shellQuote(proc.cwd)} && ${command}` : command
  if (!proc.tty) return false
  // Give the shell a beat to take back the prompt after the kill.
  await new Promise((r) => setTimeout(r, 400))
  for (const script of [TERMINAL_TTY_SCRIPT, ITERM_TTY_SCRIPT]) {
    try {
      const { stdout } = await exec('osascript', ['-e', script, `/dev/${proc.tty}`, full])
      if (stdout.trim() === 'ok') return true
    } catch {
      // that app is not scriptable right now; try the next
    }
  }
  return false
}
