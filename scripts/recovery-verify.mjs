// Restore only into a newly generated database. Never replace an existing DB.
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import pg from 'pg'
import nextEnv from '@next/env'

nextEnv.loadEnvConfig(process.cwd())
const [dumpArg] = process.argv.slice(2)
if (!dumpArg || process.argv.length !== 3) throw new Error('Usage: node scripts/recovery-verify.mjs DUMP_FILE')
const dump = path.resolve(dumpArg)
const manifestPath = path.join(path.dirname(dump), 'manifest.json')
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
const hash = crypto.createHash('sha256').update(await fs.readFile(dump)).digest('hex')
if (manifest.sha256 !== hash) throw new Error('Backup checksum mismatch')

const url = new URL(process.env.DATABASE_URL || '')
const testDatabase = `coffee_recovery_verify_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`
const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname)
if (!local) throw new Error('Verification is restricted to local PostgreSQL')
const pool = new pg.Pool({ connectionString: url.href, connectionTimeoutMillis: 5000, max: 1, ssl: false })
try {
  await pool.query(`CREATE DATABASE "${testDatabase}" TEMPLATE template0`)
} finally { await pool.end() }

const env = { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432',
  PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
  PGDATABASE: testDatabase, PGSSLMODE: 'disable', PGCONNECT_TIMEOUT: '10' }
const executable = path.join(process.env.PG_BIN_DIR || '', process.platform === 'win32' ? 'pg_restore.exe' : 'pg_restore')
const log = await fs.open(path.join(path.dirname(dump), `${testDatabase}.restore.log`), 'wx')
try {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, ['--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', '--dbname', testDatabase, dump],
      { env, stdio: ['ignore', log.fd, log.fd], windowsHide: true })
    child.once('error', () => reject(new Error('pg_restore could not start')))
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`Restore failed (${code}); see the local restore log`)))
  })
} finally { await log.close() }

url.pathname = `/${testDatabase}`
const restored = new pg.Pool({ connectionString: url.href, connectionTimeoutMillis: 5000, max: 1, ssl: false })
const report = { restoredAt: new Date().toISOString(), database: testDatabase, tables: {}, media: {} }
try {
  await restored.query('BEGIN READ ONLY')
  for (const table of ['public.orders', 'public.clients', 'public.products', 'public.admins', 'public.media', 'auth.users', 'public.companies', 'public.notifications']) {
    report.tables[table] = (await restored.query(`SELECT count(*)::int AS count FROM ${table}`)).rows[0].count
  }
  report.extensions = (await restored.query('SELECT extname, extversion FROM pg_extension ORDER BY extname')).rows
  report.policyRoles = (await restored.query('SELECT DISTINCT r.rolname FROM pg_policy p JOIN pg_roles r ON r.oid = ANY(p.polroles) ORDER BY r.rolname')).rows.map(row => row.rolname)
  const media = (await restored.query('SELECT filename FROM public.media')).rows
  let present = 0
  for (const row of media) {
    if (row.filename && path.basename(row.filename) === row.filename) {
      try { await fs.access(path.join('media', row.filename)); present += 1 } catch { /* Missing in this local snapshot. */ }
    }
  }
  report.media = { originalRecords: media.length, originalsFoundLocally: present, originalsNotFoundLocally: media.length - present }
  await restored.query('ROLLBACK')
} finally { await restored.end() }

await fs.writeFile(path.join(path.dirname(dump), 'restore-check.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, restoredAndChecked: true, verificationDatabase: testDatabase }, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
