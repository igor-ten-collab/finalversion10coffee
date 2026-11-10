import { spawn } from 'node:child_process'

// Отдельный процесс для обратной синхронизации КофеСклад — по образцу
// moysklad-status-process.mjs: инициализация Payload не попадает в основной
// процесс сайта.
export function runCoffeeskladStatusProcess({ env = process.env, signal, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const worker = spawnImpl(process.execPath, [
      '--require', './scripts/os-userinfo-workaround.cjs', '--import', 'tsx',
      'scripts/coffeesklad-status-sync.ts',
    ], { env, stdio: 'inherit', signal })
    worker.once('error', reject)
    worker.once('close', (code, exitSignal) => {
      if (exitSignal) reject(new Error(`Coffeesklad status worker stopped by ${exitSignal}`))
      else resolve({ ok: code === 0, exitCode: code })
    })
  })
}
