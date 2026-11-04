// Smoke-test the built site against the restored clone. No real emails/payments.
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import nextEnv from '@next/env'

nextEnv.loadEnvConfig(process.cwd())
const [directory] = process.argv.slice(2)
if (!directory || process.argv.length !== 3) throw new Error('Usage: node scripts/recovery-http-check.mjs BACKUP_DIRECTORY')
const verification = JSON.parse(await fs.readFile(path.join(directory, 'restore-check.json'), 'utf8'))
if (!/^coffee_recovery_verify_\d+_[a-f0-9]{6}$/.test(verification.database)) throw new Error('Not a verification DB')
const url = new URL(process.env.DATABASE_URL || '')
if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname === `/${verification.database}`) throw new Error('Unsafe DB target')
url.pathname = `/${verification.database}`
const env = { ...process.env, DATABASE_URL: url.href, DATABASE_SSL: 'false', NODE_ENV: 'production',
  PAYLOAD_DB_PUSH: 'false', MOYSKLAD_ENABLED: 'false', YOOKASSA_ENABLED: 'false',
  SMTP_EMAIL: '', SMTP_PASSWORD: '', TELEGRAM_BOT_TOKEN: '', VK_COMMUNITY_ACCESS_TOKEN: '',
  S3_BUCKET: '', S3_ENDPOINT: '', PORT: '3108', HOSTNAME: '127.0.0.1' }
const log = await fs.open(path.join(directory, 'http-check.log'), 'w')
const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', '3108', '-H', '127.0.0.1'],
  { env, stdio: ['ignore', 'pipe', log.fd], windowsHide: true })
let pending = ''
const startup = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Startup timeout')), 30_000)
  child.once('error', error => { clearTimeout(timer); reject(error) })
  child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited (${code})`)) })
  child.stdout.on('data', chunk => {
    pending += chunk.toString()
    if (pending.includes('Ready in')) { clearTimeout(timer); resolve() }
  })
})
const report = { checkedAt: new Date().toISOString(), routes: [] }
try {
  await startup
  for (const [route, expected] of [['/', [200]], ['/shop', [200]], ['/admin', [200, 302, 307]], ['/api/orders/484?depth=0', [401, 403, 404]]]) {
    const response = await fetch(`http://127.0.0.1:3108${route}`, { redirect: 'manual', signal: AbortSignal.timeout(45_000) })
    await response.text()
    report.routes.push({ route, status: response.status, ok: expected.includes(response.status) })
  }
  report.ok = report.routes.every(route => route.ok)
  await fs.writeFile(path.join(directory, 'http-check.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 1
} finally {
  child.kill('SIGTERM')
  await new Promise(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('close', resolve) })
  await log.close()
}
