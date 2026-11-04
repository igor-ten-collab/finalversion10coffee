// Read-only recovery inventory. Never print environment values or customer data.
import fs from 'node:fs/promises'
import path from 'node:path'
import nextEnv from '@next/env'
import pg from 'pg'

nextEnv.loadEnvConfig(process.cwd())

async function filesInventory(directory) {
  let files = 0, bytes = 0
  const walk = async dir => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const filename = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(filename)
      else if (entry.isFile()) {
        files += 1
        bytes += (await fs.stat(filename)).size
      }
    }
  }
  try { await walk(directory) } catch (error) { if (error.code !== 'ENOENT') throw error }
  return { files, bytes }
}

const report = { checkedAt: new Date().toISOString(), files: {}, database: { available: false } }
for (const directory of ['media', 'job-application-files', 'public/uploads']) {
  report.files[directory] = await filesInventory(directory)
}
const connectionString = process.env.DATABASE_URL
if (connectionString) {
  const hostname = new URL(connectionString).hostname
  report.database.location = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname) ? 'local' : 'remote'
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: 3000, max: 1,
    ssl: process.env.DATABASE_SSL === 'false' || !hostname.includes('.') || hostname === '127.0.0.1'
      ? false : { rejectUnauthorized: false } })
  let client
  try {
    client = await pool.connect()
    await client.query('BEGIN READ ONLY')
    await client.query("SET LOCAL statement_timeout = '5s'")
    report.database.available = true
    report.database.version = (await client.query('SHOW server_version')).rows[0].server_version
    report.database.tables = {}
    for (const table of ['public.orders', 'public.clients', 'public.products', 'public.admins', 'public.media', 'auth.users', 'public.companies', 'public.notifications', 'public.payload_migrations']) {
      const exists = await client.query('SELECT to_regclass($1) IS NOT NULL AS exists', [table])
      if (!exists.rows[0].exists) { report.database.tables[table] = { exists: false }; continue }
      const result = await client.query(`SELECT count(*)::int AS count FROM ${table}`)
      report.database.tables[table] = { exists: true, count: result.rows[0].count }
    }
    if (report.database.tables['public.orders']?.exists) {
      const columns = await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders'")
      if (columns.rows.some(row => row.column_name === 'created_at')) {
        report.database.newestOrderAt = (await client.query('SELECT max(created_at) AS newest FROM public.orders')).rows[0].newest
      }
    }
    if (report.database.tables['public.media']?.exists) {
      const columns = (await client.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'media'")).rows.map(row => row.column_name)
      const fields = ['filename', 'url'].filter(field => columns.includes(field))
      const records = (await client.query(`SELECT ${fields.join(', ')} FROM public.media`)).rows
      const publicNames = new Set()
      const indexFiles = async dir => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) await indexFiles(path.join(dir, entry.name))
          else if (entry.isFile()) publicNames.add(entry.name)
        }
      }
      await indexFiles('public')
      let named = 0, local = 0, inPublic = 0, remoteUrls = 0
      const remoteHosts = new Set()
      for (const row of records) {
        if (row.filename) {
          named += 1
          if (path.basename(row.filename) === row.filename) {
            try { await fs.access(path.join('media', row.filename)); local += 1 } catch { /* Count only. */ }
            if (publicNames.has(row.filename)) inPublic += 1
          }
        }
        if (row.url && /^https?:\/\//.test(row.url)) {
          remoteUrls += 1
          try { remoteHosts.add(new URL(row.url).hostname) } catch { /* Invalid legacy URL. */ }
        }
      }
      report.database.mediaCoverage = { records: records.length, recordsWithFilename: named,
        originalsFoundInMedia: local, originalsFoundInPublic: inPublic, recordsWithRemoteUrl: remoteUrls,
        remoteHosts: [...remoteHosts] }
    }
    await client.query('ROLLBACK')
  } catch (error) {
    report.database.errorCode = error.code || 'READ_FAILED'
    if (client) await client.query('ROLLBACK').catch(() => {})
  } finally {
    client?.release()
    await pool.end()
  }
} else report.database.errorCode = 'DATABASE_URL_NOT_CONFIGURED'
console.log(JSON.stringify(report, null, 2))
