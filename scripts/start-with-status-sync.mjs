import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import nextEnv from '@next/env'
import { startMoyskladStatusScheduler } from './moysklad-status-scheduler.mjs'
import { startYooKassaPaymentScheduler } from './yookassa-payment-scheduler.mjs'
import { startCoffeeskladStatusScheduler } from './coffeesklad-status-scheduler.mjs'
import { startMoyskladCoffeeskladBridge } from './moysklad-coffeesklad-bridge.mjs'

export function startApplication({
  appProcess = process,
  spawnImpl = spawn,
  loadEnvironment = nextEnv.loadEnvConfig,
  startScheduler = startMoyskladStatusScheduler,
  startPaymentScheduler = startYooKassaPaymentScheduler,
  startCoffeeskladScheduler = startCoffeeskladStatusScheduler,
  startMsCsBridge = startMoyskladCoffeeskladBridge,
  logger = console,
} = {}) {
  appProcess.env.NODE_ENV ||= 'production'
  // Next loads .env files in its child process. Load them in the parent too,
  // before checking MOYSKLAD_ENABLED or creating the background worker.
  loadEnvironment(appProcess.cwd())
  const server = spawnImpl(appProcess.execPath, ['node_modules/next/dist/bin/next', 'start', ...appProcess.argv.slice(2)], {
    stdio: 'inherit',
    env: appProcess.env,
  })
  const stopScheduler = startScheduler({ env: appProcess.env })
  const stopPaymentScheduler = startPaymentScheduler({ env: appProcess.env })
  const stopCoffeeskladScheduler = startCoffeeskladScheduler({ env: appProcess.env })
  const stopMsCsBridge = startMsCsBridge({ env: appProcess.env })
  const signalHandlers = new Map()
  const cleanup = () => {
    stopScheduler()
    stopPaymentScheduler()
    stopCoffeeskladScheduler()
    stopMsCsBridge()
    for (const [signal, handler] of signalHandlers) appProcess.off(signal, handler)
  }
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const handler = () => {
      stopScheduler()
      stopPaymentScheduler()
      server.kill(signal)
    }
    signalHandlers.set(signal, handler)
    appProcess.on(signal, handler)
  }
  server.once('error', (error) => {
    cleanup()
    logger.error('[Next.js]', error.message)
    appProcess.exitCode = 1
  })
  server.once('exit', (code, signal) => {
    cleanup()
    appProcess.exitCode = code ?? (signal === 'SIGTERM' || signal === 'SIGINT' ? 0 : 1)
  })
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startApplication()
