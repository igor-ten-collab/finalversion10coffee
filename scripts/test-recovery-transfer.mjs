// Isolated orchestration tests. No SSH, real backups, or databases are used.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { restoreFromLocal } from '../deploy/selectel/restore-from-local.mjs'

async function fixture(t, { existing = 'MISSING', failRestore = false } = {}) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'coffee-restore-tests-'))
  t.after(async () => {
    const resolved = path.resolve(workspace)
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith('coffee-restore-tests-')) {
      throw new Error('Unsafe test cleanup target')
    }
    await fs.rm(resolved, { recursive: true })
  })
  const directory = path.join(workspace, 'recovery-data', 'local-2026-11-04')
  const source = path.join(workspace, 'deploy', 'selectel')
  await fs.mkdir(directory, { recursive: true })
  await fs.mkdir(source, { recursive: true })
  const original = Buffer.from([0, 255, 13, 10, 42, 128])
  const sha256 = createHash('sha256').update(original).digest('hex')
  await fs.writeFile(path.join(directory, 'site.dump'), original)
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ sha256 }))
  await fs.writeFile(path.join(source, 'restore-new-database.sh'), '\uFEFF#!/usr/bin/env bash\r\nset -e\r\n')
  const calls = [], messages = []
  const options = { workspace, logger: { log: text => messages.push(text) },
    run: async (program, args, opts) => {
      calls.push({ program, args, opts })
      if (opts?.capture) return existing === 'SAME' ? `${sha256}  /root/backup/site.dump\n` : existing
      if (failRestore && program === 'ssh' && args.at(-1).startsWith('bash ')) throw new Error('remote restore rejected: target is not empty')
      return ''
    } }
  return { options, directory, original, sha256, calls, messages }
}

test('transfers the binary archive with scp, stages LF Bash and confirms only after successful remote execution', async t => {
  const f = await fixture(t)
  const result = await restoreFromLocal(f.options)
  assert.equal(result.checksum, f.sha256)
  assert.deepEqual(f.calls.map(call => call.program), ['ssh', 'ssh', 'scp', 'scp', 'ssh'])
  assert.equal(f.calls[2].args.at(-2), path.join(f.directory, 'site.dump'))
  assert.match(f.calls[2].args.at(-1), /^root@176\.53\.252\.204:\/root\/10coffee-recovery-/)
  assert.equal(await fs.readFile(path.join(f.directory, 'restore-new-database.sh'), 'utf8'), '#!/usr/bin/env bash\nset -e\n')
  assert.deepEqual(await fs.readFile(path.join(f.directory, 'site.dump')), f.original)
  assert.match(f.messages.at(-1), /completed successfully/)
})

test('corrupt local backup stops before any SSH or upload', async t => {
  const f = await fixture(t)
  await fs.appendFile(path.join(f.directory, 'site.dump'), 'changed')
  await assert.rejects(() => restoreFromLocal(f.options), /checksum mismatch/)
  assert.equal(f.calls.length, 0)
})

test('different remote backup is preserved and restoration never starts', async t => {
  const f = await fixture(t, { existing: 'different-hash  /root/backup/site.dump' })
  await assert.rejects(() => restoreFromLocal(f.options), /Refusing to overwrite/)
  assert.deepEqual(f.calls.map(call => call.program), ['ssh', 'ssh'])
})

test('matching remote backup is reused without re-uploading the archive', async t => {
  const f = await fixture(t, { existing: 'SAME' })
  await restoreFromLocal(f.options)
  assert.equal(f.calls.filter(call => call.program === 'scp').length, 1)
  assert.match(f.calls.find(call => call.program === 'scp').args.at(-1), /restore-new-database\.sh$/)
})

test('remote rejection never reports a successful restore', async t => {
  const f = await fixture(t, { failRestore: true })
  await assert.rejects(() => restoreFromLocal(f.options), /target is not empty/)
  assert.equal(f.messages.some(message => message.includes('completed successfully')), false)
})

test('invalid connection values and Coolify internal DB selection stop before SSH', async t => {
  const f = await fixture(t)
  for (const options of [{ server: 'host; command' }, { port: 0 }, { container: 'coolify-db' }, { container: 'db; command' }]) {
    await assert.rejects(() => restoreFromLocal({ ...f.options, ...options }), /Invalid/)
  }
  assert.equal(f.calls.length, 0)
})
