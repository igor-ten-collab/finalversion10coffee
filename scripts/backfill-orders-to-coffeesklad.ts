import { syncOrderToCoffeeskladById } from "../lib/coffeesklad/sync"
import { getCoffeeskladConfig, isCoffeeskladReady } from "../lib/coffeesklad/config"
import { preparePayloadRuntime } from "./payload-runtime"
import type { Where } from "payload"

// Разовый перенос существующих заказов сайта в КофеСклад.
// Идемпотентно: КофеСклад дедуплицирует по external_id, уже выгруженные
// заказы (coffeeskladSyncStatus = synced) пропускаются без --force.
//
// Запуск (внутри контейнера сайта):
//   node --require ./scripts/os-userinfo-workaround.cjs --import tsx scripts/backfill-orders-to-coffeesklad.ts
// Опции:
//   --limit N             только первые N заказов (для проверки на малой выборке)
//   --order-number 10C-X  один конкретный заказ
//   --include-cancelled   выгружать и отменённые заказы (по умолчанию пропускаются)
//   --force               выгружать повторно даже уже синхронизированные
async function main() {
  const args = process.argv.slice(2)
  const opt = { limit: 0, orderNumber: "", includeCancelled: false, force: false }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit") opt.limit = Number(args[++i]) || 0
    else if (args[i] === "--order-number") opt.orderNumber = String(args[++i] || "").trim()
    else if (args[i] === "--include-cancelled") opt.includeCancelled = true
    else if (args[i] === "--force") opt.force = true
    else throw new Error(`Неизвестный аргумент: ${args[i]}`)
  }

  const config = getCoffeeskladConfig()
  if (!isCoffeeskladReady(config)) {
    throw new Error("КофеСклад не настроен: задайте COFFESKLAD_ENABLED, COFFESKLAD_URL, COFFESKLAD_API_KEY")
  }

  preparePayloadRuntime()
  const [{ getPayload }, configModule] = await Promise.all([
    import("payload"),
    import("../payload.config"),
  ])
  const payload = await getPayload({ config: configModule.default })

  const and: Where[] = []
  if (opt.orderNumber) and.push({ orderId: { equals: opt.orderNumber } })
  if (!opt.includeCancelled) and.push({ status: { not_equals: "cancelled" } })
  if (!opt.force) and.push({ coffeeskladSyncStatus: { not_equals: "synced" } })
  const where: Where = and.length > 0 ? { and } : {}

  const summary = { total: 0, synced: 0, duplicates: 0, skipped: 0, errors: [] as string[] }
  let page = 1
  let fetched = 0
  for (;;) {
    const { docs, hasNextPage } = await payload.find({
      collection: "orders",
      where,
      sort: "createdAt",
      limit: 50,
      page,
      depth: 0,
      overrideAccess: true,
    })
    if (docs.length === 0) break
    for (const doc of docs) {
      if (opt.limit && summary.total >= opt.limit) break
      summary.total++
      const label = `${doc.orderId || doc.id}`
      const result = await syncOrderToCoffeeskladById(payload, doc.id)
      if (result.error) {
        summary.errors.push(`${label}: ${result.error}`)
        console.error(`[backfill] ${label}: ошибка — ${result.error}`)
      } else if (result.skipped) {
        summary.skipped++
        console.log(`[backfill] ${label}: пропущен`)
      } else {
        summary.synced++
        if (result.duplicate) summary.duplicates++
        console.log(`[backfill] ${label}: выгружен (${result.orderNumber || "?"})${result.duplicate ? " [дубликат]" : ""}`)
      }
      // щадящая пауза, чтобы не перегружать КофеСклад
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    fetched += docs.length
    if (!hasNextPage || (opt.limit && summary.total >= opt.limit)) break
    page++
  }

  console.log("=== ИТОГ ===")
  console.log(JSON.stringify({ ...summary, fetched }, null, 2))
  process.exit(summary.errors.length ? 1 : 0)
}

main()
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
