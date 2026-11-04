// Export the configured database. Passwords travel only through the child env.
// Backup data must stay out of Git and Docker build contexts.
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import nextEnv from '@next/env'

nextEnv.loadEnvConfig(process.cwd())

const args = process.argv.slice(2)
if (args.length !== 1) throw new Error('Usage: node scripts/recovery-backup.mjs NEW_OUTPUT_DIRECTORY')
const output = path.resolve(args[0])
await fs.mkdir(output, { recursive: false })
const url = new URL(process.env.DATABASE_URL || '')
const binaryDir = process.env.PG_BIN_DIR || ''
const binary = name => path.join(binaryDir, name + (process.platform === 'win32' ? '.exe' : ''))
const env = { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432',
  PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
  PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGCONNECT_TIMEOUT: '10' }
if (process.env.DATABASE_SSL === 'false') env.PGSSLMODE = 'disable'

async function command(name, argv, outputFile) {
  const logFile = path.join(output, `${name}.log`)
  const log = await fs.open(logFile, 'wx')
  const out = outputFile ? await fs.open(outputFile, 'wx') : null
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(binary(name), argv, { env, stdio: ['ignore', out?.fd ?? log.fd, log.fd], windowsHide: true })
      child.once('error', () => reject(new Error(`${name} could not start; inspect its local log`)))
      child.once('close', code => code === 0 ? resolve() : reject(new Error(`${name} failed (${code}); inspect its local log`)))
    })
  } finally { await out?.close(); await log.close() }
}

const dump = path.join(output, 'site.dump')
await command('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--file', dump])
await command('pg_restore', ['--list', dump], path.join(output, 'archive-list.txt'))
const contents = await fs.readFile(dump)
if (!contents.length) throw new Error('Empty backup')
const manifest = { createdAt: new Date().toISOString(), dump: 'site.dump', bytes: contents.length,
  sha256: crypto.createHash('sha256').update(contents).digest('hex'), archiveListVerified: true,
  restoredAndChecked: false }
await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ output, ...manifest }, null, 2))
