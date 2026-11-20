import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import nextEnv from '@next/env'
import { startYooKassaPaymentScheduler } from './yookassa-payment-scheduler.mjs'
import { startCoffeeskladStatusScheduler } from './coffeesklad-status-scheduler.mjs'

// T-024 (20.11.2026): планировщик статусов МойСклад → сайт и мост МойСклад → КофеСклад
// убраны из автозапуска. Мост был отключён заглушкой 12.11 (статусы/оплаты ведутся
// вручную в КофеСклад), эндпоинт /api/public/ms-sync удалён из КофеСклад (build60).
// Планировщик МС → сайт падал каждые 10 минут с ~04.10 и не нёс пользы: статусы
// на сайт приходят из КофеСклад (coffeesklad-status-scheduler). Ручной запуск
// процедуры МС остался доступен: node scripts/moysklad-maintenance.mjs statuses.

export function startApplication({
  appProcess = process,
  spawnImpl = spawn,
  loadEnvironment = nextEnv.loadEnvConfig,
  startPaymentScheduler = startYooKassaPaymentScheduler,
  startCoffeeskladScheduler = startCoffeeskladStatusScheduler,
  logger = console,
} = {}) {
  appProcess.env.NODE_ENV ||= 'production'
  // Next loads .env files in its child process. Load them in the parent too.
  loadEnvironment(appProcess.cwd())
  const server = spawnImpl(appProcess.execPath, ['node_modules/next/dist/bin/next', 'start', ...appProcess.argv.slice(2)], {
    stdio: 'inherit',
    env: appProcess.env,
  })
  const stopPaymentScheduler = startPaymentScheduler({ env: appProcess.env })
  const stopCoffeeskladScheduler = startCoffeeskladScheduler({ env: appProcess.env })
  const signalHandlers = new Map()
  const cleanup = () => {
    stopPaymentScheduler()
    stopCoffeeskladScheduler()
    for (const [signal, handler] of signalHandlers) appProcess.off(signal, handler)
    signalHandlers.clear()
  }
  for (const signal of ['SIGTERM', 'SIGINT']) {
    const handler = () => {
      cleanup()
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
