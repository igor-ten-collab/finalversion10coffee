// Recover named media from working-tree assets or Git objects into a NEW folder.
// Original media, Git state and the source database remain unchanged.
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import pg from 'pg'
import nextEnv from '@next/env'

nextEnv.loadEnvConfig(process.cwd())
const exec = promisify(execFile)
const [outputArg] = process.argv.slice(2)
if (!outputArg || process.argv.length !== 3) throw new Error('Usage: node scripts/recovery-salvage-media.mjs NEW_OUTPUT_FOLDER')
const output = path.resolve(outputArg)
await fs.mkdir(output, { recursive: false })
const destination = path.join(output, 'media')
await fs.cp('media', destination, { recursive: true, errorOnExist: true, force: false })
const local = new Map()
async function index(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const filename = path.join(dir, entry.name)
    if (entry.isDirectory()) await index(filename)
    else if (entry.isFile() && !local.has(entry.name)) local.set(entry.name, filename)
  }
}
await index('media')
await index('public')
const objects = (await exec('git', ['-c', 'core.quotePath=false', 'rev-list', '--objects', '--all'], { maxBuffer: 64 * 1024 * 1024 })).stdout
const historical = new Map()
for (const line of objects.split('\n')) {
  const match = line.match(/^([a-f0-9]{40,64}) (.+)$/)
  if (match && !historical.has(path.basename(match[2]))) historical.set(path.basename(match[2]), match[1])
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: false, max: 1, connectionTimeoutMillis: 5000 })
let records
try { records = (await pool.query('SELECT filename, filesize FROM public.media')).rows } finally { await pool.end() }
const report = { checkedAt: new Date().toISOString(), records: records.length,
  foundInWorkingTree: 0, foundInGitHistory: 0, rejectedSizeMismatch: 0, notFound: 0 }
for (const { filename, filesize } of records) {
  if (!filename || path.basename(filename) !== filename) { report.notFound += 1; continue }
  const target = path.join(destination, filename)
  if (local.has(filename)) {
    const stat = await fs.stat(local.get(filename))
    if (!filesize || Number(filesize) !== stat.size) {
      report.rejectedSizeMismatch += 1
      report.notFound += 1
      continue
    }
    try { await fs.copyFile(local.get(filename), target, 1) } catch (error) { if (error.code !== 'EEXIST') throw error }
    report.foundInWorkingTree += 1
  } else if (historical.has(filename)) {
    const { stdout } = await exec('git', ['cat-file', 'blob', historical.get(filename)], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
    if (!filesize || Number(filesize) !== stdout.length) {
      report.rejectedSizeMismatch += 1
      report.notFound += 1
      continue
    }
    await fs.writeFile(target, stdout, { flag: 'wx' })
    report.foundInGitHistory += 1
  } else report.notFound += 1
}
await fs.writeFile(path.join(output, 'media-recovery.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify(report, null, 2))
