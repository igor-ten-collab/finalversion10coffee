import { spawn } from 'node:child_process'

export function runYooKassaPaymentProcess({ env = process.env, signal, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const worker = spawnImpl(process.execPath, [
      '--require', './scripts/os-userinfo-workaround.cjs', '--import', 'tsx',
      'scripts/reconcile-yookassa-payments.ts',
    ], { env, stdio: 'inherit', signal, windowsHide: true })
    worker.once('error', reject)
    worker.once('close', (code, exitSignal) => {
      if (exitSignal) reject(new Error(`Payment worker stopped by ${exitSignal}`))
      else resolve({ ok: code === 0, exitCode: code })
    })
  })
}
