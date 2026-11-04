// Run directly with Node.js in the user's working SSH terminal.
// No PowerShell execution-policy changes; no passwords or private keys copied.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'

export function runCommand(program, args, { capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      stdio: ['inherit', capture ? 'pipe' : 'inherit', 'inherit'], windowsHide: true,
    })
    let output = ''
    if (capture) child.stdout.setEncoding('utf8').on('data', data => { output += data })
    child.once('error', () => reject(new Error(`Could not start ${program}. Check that it is installed and available in PATH.`)))
    child.once('close', code => code === 0 ? resolve(output) : reject(new Error(`${program} failed (exit code ${code}). Recovery has not been confirmed.`)))
  })
}

export async function restoreFromLocal({
  server = '176.53.252.204', port = 22, container = '',
  workspace = fileURLToPath(new URL('../../', import.meta.url)),
  run = runCommand, logger = console,
} = {}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(server)) throw new Error('Invalid server address')
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SSH port')
  if (container && (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container) || container === 'coolify-db')) {
    throw new Error('Invalid application database container')
  }
  const directory = path.join(workspace, 'recovery-data', 'local-2026-11-04')
  const dump = path.join(directory, 'site.dump')
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'))
  const checksum = createHash('sha256').update(await fs.readFile(dump)).digest('hex')
  if (checksum !== manifest.sha256) throw new Error('Local backup checksum mismatch. Nothing was sent to the server.')
  const remoteDirectory = `/root/10coffee-recovery-${checksum.slice(0, 12)}`
  const remote = `root@${server}`
  const sshOptions = ['-p', String(port), '-o', 'ConnectTimeout=20', '-o', 'StrictHostKeyChecking=accept-new']
  const scpOptions = ['-P', String(port), '-o', 'ConnectTimeout=20', '-o', 'StrictHostKeyChecking=accept-new']
  const stagedScript = path.join(directory, 'restore-new-database.sh')
  const script = (await fs.readFile(path.join(workspace, 'deploy', 'selectel', 'restore-new-database.sh'), 'utf8'))
    .replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  await fs.writeFile(stagedScript, script, 'utf8')

  logger.log(`Checking SSH and the private recovery directory on ${server}...`)
  await run('ssh', [...sshOptions, remote,
    `test "$(id -u)" = 0 && command -v docker >/dev/null && install -d -m 700 ${remoteDirectory}`])
  const remoteHash = (await run('ssh', [...sshOptions, remote,
    `if test -e ${remoteDirectory}/site.dump; then sha256sum ${remoteDirectory}/site.dump; else echo MISSING; fi`],
  { capture: true })).trim()
  if (remoteHash === 'MISSING') {
    logger.log('Uploading the verified database archive...')
    await run('scp', [...scpOptions, dump, `${remote}:${remoteDirectory}/site.dump`])
  } else if (!remoteHash.startsWith(`${checksum} `)) {
    throw new Error('A different remote backup exists. Refusing to overwrite it.')
  }
  await run('scp', [...scpOptions, stagedScript, `${remote}:${remoteDirectory}/restore-new-database.sh`])
  logger.log('Restoring only if the target application database is empty...')
  await run('ssh', [...sshOptions, remote,
    `bash ${remoteDirectory}/restore-new-database.sh${container ? ` ${container}` : ''}`])
  logger.log('Database restore command completed successfully. Check the RESTORE VERIFIED counts printed above.')
  return { server, remoteDirectory, checksum }
}

async function main() {
  const options = {}
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node restore-from-local.mjs [--server HOST] [--port PORT] [--container NAME]')
    return
  }
  for (let i = 0; i < args.length; i += 2) {
    if (!['--server', '--port', '--container'].includes(args[i]) || !args[i + 1]) throw new Error('Invalid arguments; use --help')
    options[args[i].slice(2)] = args[i] === '--port' ? Number(args[i + 1]) : args[i + 1]
  }
  await restoreFromLocal(options)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
