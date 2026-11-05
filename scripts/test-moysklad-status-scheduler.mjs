import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { startMoyskladStatusScheduler } from './moysklad-status-scheduler.mjs'
import { runMoyskladStatusProcess } from './moysklad-status-process.mjs'
import { startApplication } from './start-with-status-sync.mjs'

function fixture(env = { MOYSKLAD_ENABLED: 'true', PORT: '3001' }, runSync) {
  const timers = [], calls = [], messages = [], cleared = []
  const stop = startMoyskladStatusScheduler({ env,
    setTimer: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer },
    clearTimer: timer => cleared.push(timer),
    logger: { log: value => messages.push(value), error: (...values) => messages.push(values.join(' ')) },
    runSync: async options => { calls.push(options); return runSync ? runSync(options) : { ok: true, exitCode: 0 } },
  })
  return { stop, timers, calls, messages, cleared }
}

test('scheduler runs the CLI without CRON_SECRET and waits for completion before scheduling again', async () => {
  let complete
  const f = fixture(undefined, () => new Promise(resolve => { complete = resolve }))
  const running = f.timers[0].fn()
  assert.equal(f.calls.length, 1)
  assert.equal(f.calls[0].env.MOYSKLAD_ENABLED, 'true')
  assert.ok(f.calls[0].signal instanceof AbortSignal)
  assert.equal(f.timers.length, 1, 'no second timer while the request is running')
  complete({ ok: true, exitCode: 0 })
  await running
  assert.equal(f.timers[1].ms, 600000)
  assert.ok(f.messages.every(message => !message.includes('test-secret')))
  assert.match(f.messages[0], /enabled: first import in 10 seconds/)
  assert.match(f.messages.at(-1), /status import completed/)
  f.stop()
})

test('disabled integration starts no workers and logs its state', () => {
  for (const env of [{ MOYSKLAD_ENABLED: 'false', CRON_SECRET: 'test-secret' }, {}]) {
    const f = fixture(env)
    assert.equal(f.timers.length, 0)
    assert.equal(f.calls.length, 0)
    assert.match(f.messages[0], /disabled: MOYSKLAD_ENABLED/)
    f.stop()
  }
})

test('worker launch failure retries in one minute; import errors retain the full-sweep interval', async () => {
  for (const [runSync, delay] of [[async () => { throw new Error('spawn failed') }, 60000], [async () => ({ ok: false, exitCode: 1 }), 600000]]) {
    const f = fixture(undefined, runSync)
    await f.timers[0].fn()
    assert.equal(f.timers[1].ms, delay)
    assert.ok(f.messages.every(message => !message.includes('test-secret')))
    f.stop()
  }
})

test('shutdown aborts an active worker and prevents later work', async () => {
  const f = fixture(undefined, options => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted')))
  }))
  const running = f.timers[0].fn()
  f.stop()
  await running
  assert.equal(f.calls[0].signal.aborted, true)
  assert.equal(f.timers.length, 1)
  await f.timers[0].fn()
  assert.equal(f.calls.length, 1)
})

test('worker uses the maintenance TypeScript entrypoint and reports real child-process success or failure', async () => {
  for (const exitCode of [0, 1]) {
    const env = { ...process.env, MOYSKLAD_ENABLED: 'true' }
    const result = await runMoyskladStatusProcess({ env, spawnImpl: (binary, args, options) => {
      assert.deepEqual(args, ['--require', './scripts/os-userinfo-workaround.cjs', '--import', 'tsx', 'scripts/sync-moysklad-order-statuses.ts'])
      assert.equal(options.env, env)
      return spawn(binary, ['-e', `process.exit(${exitCode})`], options)
    } })
    assert.equal(result.ok, exitCode === 0)
    assert.equal(result.exitCode, exitCode)
  }
})

test('stopping the scheduler terminates its real child process', async () => {
  const controller = new AbortController()
  let child
  const result = runMoyskladStatusProcess({ signal: controller.signal, spawnImpl: (binary, args, options) => {
    child = spawn(binary, ['-e', 'setInterval(() => {}, 1000)'], options)
    return child
  } })
  const closed = new Promise(resolve => child.once('close', resolve))
  controller.abort()
  await assert.rejects(result, { name: 'AbortError' })
  await closed
  assert.equal(child.killed, true)
})

function startupFixture() {
  const appProcess = Object.assign(new EventEmitter(), {
    env: {}, argv: ['node', 'scripts/start-with-status-sync.mjs', '-p', '3099'], execPath: 'node', cwd: () => '/app',
  })
  const server = new EventEmitter()
  const events = []
  server.kill = signal => { events.push(['kill', signal]) }
  const start = () => startApplication({ appProcess,
    loadEnvironment: dir => {
      events.push(['env', dir, appProcess.env.NODE_ENV])
      appProcess.env.MOYSKLAD_ENABLED = 'true'
    },
    spawnImpl: (binary, args, options) => {
      events.push(['server', binary, args, options.env.MOYSKLAD_ENABLED])
      return server
    },
    startScheduler: ({ env }) => {
      events.push(['scheduler', env.MOYSKLAD_ENABLED])
      return () => { events.push(['stop']) }
    },
    startPaymentScheduler: () => {
      events.push(['payment-scheduler'])
      return () => { events.push(['stop-payments']) }
    }, logger: { error: (...args) => events.push(['error', ...args]) },
  })
  return { start, appProcess, server, events }
}

test('npm start loads the production environment and starts both Next and status scheduler', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.scripts.start, 'node scripts/start-with-status-sync.mjs')
  const f = startupFixture()
  f.start()
  assert.deepEqual(f.events, [
    ['env', '/app', 'production'],
    ['server', 'node', ['node_modules/next/dist/bin/next', 'start', '-p', '3099'], 'true'],
    ['scheduler', 'true'],
    ['payment-scheduler'],
  ])
  f.appProcess.emit('SIGTERM')
  assert.deepEqual(f.events.slice(-3), [['stop'], ['stop-payments'], ['kill', 'SIGTERM']])
  f.server.emit('exit', 0, null)
  assert.equal(f.appProcess.exitCode, 0)
  assert.equal(f.appProcess.listenerCount('SIGTERM'), 0)
})

test('failed Next startup stops the scheduler and preserves the failing exit code', () => {
  const f = startupFixture()
  f.start()
  f.server.emit('error', new Error('startup failed'))
  assert.equal(f.appProcess.exitCode, 1)
  assert.equal(f.appProcess.listenerCount('SIGINT'), 0)
  assert.ok(f.events.some(event => event[0] === 'stop'))
  assert.deepEqual(f.events.at(-1), ['error', '[Next.js]', 'startup failed'])
})
