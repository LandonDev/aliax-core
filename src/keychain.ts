import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export async function readPassword(service: string): Promise<string> {
  const { stdout } = await exec('security', ['find-generic-password', '-s', service, '-w'])
  return stdout.replace(/\n$/, '')
}

export async function writePassword(service: string, account: string, value: string): Promise<void> {
  await exec('security', ['add-generic-password', '-U', '-s', service, '-a', account, '-w', value])
}
