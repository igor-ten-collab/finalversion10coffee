import { runYooKassaPaymentProcess } from './yookassa-payment-process.mjs'

export function startYooKassaPaymentScheduler({
  env = process.env, runSync = runYooKassaPaymentProcess,
  setTimer = setTimeout, clearTimer = clearTimeout, logger = console,
} = {}) {
  if (['false', '0', 'no', 'off'].includes((env.YOOKASSA_PAYMENT_RECONCILIATION_ENABLED || '').toLowerCase())) {
    logger.log('[YooKassa payment scheduler] disabled by YOOKASSA_PAYMENT_RECONCILIATION_ENABLED')
    return () => {}
  }
  // Payload payment settings override YOOKASSA_ENABLED, so the worker checks
  // the effective configuration instead of relying on the environment alone.
  let stopped = false
  let timer
  let request
  const run = async () => {
    if (stopped) return
    request = new AbortController()
    try {
      logger.log('[YooKassa payment scheduler] starting payment reconciliation')
      const result = await runSync({ env, signal: request.signal })
      if (result.ok) logger.log('[YooKassa payment scheduler] reconciliation completed')
      else logger.error(`[YooKassa payment scheduler] reconciliation reported errors; exit code ${result.exitCode}`)
    } catch (error) {
      if (!stopped) logger.error('[YooKassa payment scheduler]', error instanceof Error ? error.message : 'WORKER_FAILED')
    } finally {
      request = undefined
      if (!stopped) timer = setTimer(run, 60_000)
    }
  }
  logger.log('[YooKassa payment scheduler] enabled: first check in 15 seconds; interval 1 minute after completion')
  timer = setTimer(run, 15_000)
  return () => {
    stopped = true
    clearTimer(timer)
    request?.abort()
  }
}
