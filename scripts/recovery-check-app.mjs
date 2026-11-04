// Run the current application build against the restored local verification DB.
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import nextEnv from '@next/env'
import pg from 'pg'

nextEnv.loadEnvConfig(process.cwd())
const [directory, action = 'build'] = process.argv.slice(2)
if (!directory || !['build', 'migrate', 'migrate-status', 'dev', 'start'].includes(action)) {
  throw new Error('Usage: node scripts/recovery-check-app.mjs BACKUP_DIRECTORY [build|migrate|migrate-status|dev|start]')
}
const report = JSON.parse(await fs.readFile(path.join(directory, 'restore-check.json'), 'utf8'))
if (!/^coffee_recovery_verify_\d+_[a-f0-9]{6}$/.test(report.database)) throw new Error('Not a generated verification database')
const url = new URL(process.env.DATABASE_URL || '')
if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname === `/${report.database}`) {
  throw new Error('Refusing to use the source database or a remote server')
}
url.pathname = `/${report.database}`
const pool = new pg.Pool({ connectionString: url.href, ssl: false, connectionTimeoutMillis: 5000, max: 1 })
try {
  // Only the disposable verification clone is changed. Preserve the dump.
  await pool.query('UPDATE public.payment_settings SET enabled = false')
} finally { await pool.end() }
const env = { ...process.env, DATABASE_URL: url.href, DATABASE_SSL: 'false',
  NODE_ENV: action === 'dev' ? 'development' : 'production', PAYLOAD_DB_PUSH: 'false',
  MOYSKLAD_ENABLED: 'false', YOOKASSA_ENABLED: 'false', YANDEX_DELIVERY_ENV: 'test',
  SMTP_EMAIL: '', SMTP_PASSWORD: '', TELEGRAM_BOT_TOKEN: '', VK_COMMUNITY_ACCESS_TOKEN: '',
  DADATA_API_KEY: '', S3_BUCKET: '', S3_ENDPOINT: '',
  ...(['dev', 'start'].includes(action) ? {
    AUTH_COOKIE_SECURE: 'false', SHOP_SITE_URL: 'http://localhost:3108/main',
    NEXT_PUBLIC_SERVER_URL: 'http://localhost:3108', NEXT_PUBLIC_SITE_URL: 'http://localhost:3108',
  } : {}) }
const command = action === 'migrate' || action === 'migrate-status'
  ? ['scripts/payload-migrate.mjs', action === 'migrate' ? 'migrate' : 'migrate:status']
  : ['--max-old-space-size=4096', 'node_modules/next/dist/bin/next', action,
    ...(['dev', 'start'].includes(action) ? ['-p', '3108', '-H', '127.0.0.1'] : [])]
console.log(`Checking ${action} against isolated database ${report.database}; external integrations disabled`)
const child = spawn(process.execPath, command, { env, stdio: 'inherit', windowsHide: true })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.once('error', () => { console.error('Application check could not start'); process.exitCode = 1 })
child.once('close', code => { process.exitCode = code ?? 1 })
