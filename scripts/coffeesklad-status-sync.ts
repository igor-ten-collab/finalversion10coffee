import { runCoffeeskladStatusSync } from "../lib/coffeesklad/status-sync"
import { preparePayloadRuntime } from "./payload-runtime"

// CLI-воркер обратной синхронизации КофеСклад → сайт.
// Запускается планировщиком (coffeesklad-status-scheduler.mjs) отдельным
// процессом, чтобы инициализация Payload не попадала в основной процесс сайта.
async function main() {
  preparePayloadRuntime()
  const [{ getPayload }, configModule] = await Promise.all([
    import("payload"),
    import("../payload.config"),
  ])
  const payload = await getPayload({ config: configModule.default })
  const result = await runCoffeeskladStatusSync(payload)
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.ok ? 0 : 1)
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
