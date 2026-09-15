import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export async function isRunning(appName: string): Promise<boolean> {
  const { stdout } = await exec('osascript', ['-e', `application "${appName}" is running`])
  return stdout.trim() === 'true'
}

export async function quitApp(appName: string): Promise<void> {
  await exec('osascript', ['-e', `tell application "${appName}" to quit`])
  for (let i = 0; i < 20; i++) {
    if (!(await isRunning(appName))) return
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`${appName} did not quit`)
}

export async function launchApp(appName: string): Promise<void> {
  await exec('open', ['-a', appName])
}
