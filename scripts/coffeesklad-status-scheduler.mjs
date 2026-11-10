import { runCoffeeskladStatusProcess } from './coffeesklad-status-process.mjs'

// Плановая обратная синхронизация КофеСклад → сайт (цены, наличие, статусы
// заказов) каждые 15 минут. По образцу moysklad-status-scheduler.mjs:
// без HTTP и внешнего cron, воркеры не пересекаются.
export function startCoffeeskladStatusScheduler({
  env = process.env,
  runSync = runCoffeeskladStatusProcess,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  logger = console,
} = {}) {
  if (!['1', 'true', 'yes', 'on'].includes((env.COFFESKLAD_ENABLED || '').toLowerCase())) {
    logger.log('[Coffeesklad status scheduler] disabled: COFFESKLAD_ENABLED is not enabled')
    return () => {}
  }
  let stopped = false
  let timer
  let request
  const run = async () => {
    if (stopped) return
    let delay = 15 * 60_000
    request = new AbortController()
    try {
      logger.log('[Coffeesklad status scheduler] starting status sync')
      const result = await runSync({ env, signal: request.signal })
      if (!result.ok) {
        logger.error(`[Coffeesklad status scheduler] sync failed; worker exit code ${result.exitCode}`)
      } else {
        logger.log('[Coffeesklad status scheduler] status sync completed')
      }
    } catch (error) {
      if (!stopped) logger.error('[Coffeesklad status scheduler]', error instanceof Error ? error.message : 'Worker failed')
      delay = 60_000
    } finally {
      request = undefined
      if (!stopped) timer = setTimer(run, delay)
    }
  }
  logger.log('[Coffeesklad status scheduler] enabled: first sync in 30 seconds; interval 15 minutes after completion')
  timer = setTimer(run, 30_000)
  return () => {
    stopped = true
    clearTimer(timer)
    request?.abort()
  }
}
