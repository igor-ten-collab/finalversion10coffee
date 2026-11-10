// Обратная синхронизация КофеСклад → сайт.
// Общая логика для HTTP-роута (ручной запуск) и фонового планировщика.
//
// 1. Цены и наличие: КофеСклад /api/public/catalog → варианты (price, isAvailable,
//    видимость товара) по артикулам sku/skuGround.
// 2. Статусы заказов: КофеСклад /api/public/orders-status → orders.status по
//    external_id (только для ещё не завершённых заказов сайта).

import type { Payload } from "payload"
import { getCoffeeskladConfig, isCoffeeskladReady } from "./config"

// Статус заказа в КофеСклад → статус заказа на сайте
const ORDER_STATUS_MAP: Record<string, string> = {
  new: "new",
  confirmed: "confirmed",
  assembled: "ready",
  shipped: "shipped",
  delivered: "delivered",
  paid: "paid",
  cancelled: "cancelled",
}

interface CatalogItem {
  id: number
  name: string
  barcode: string | null
  price: number | null
  stock: number
}

interface CoffeeskladOrderStatus {
  id: number
  number: string
  external_id: string
  status: string
  paid: number
}

export interface CoffeeskladStatusSyncResult {
  ok: boolean
  skipped?: boolean
  reason?: string
  pricesUpdated: number
  availabilityUpdated: number
  visibilityUpdated: number
  orderStatusesUpdated: number
  errors: string[]
}

export async function runCoffeeskladStatusSync(payload: Payload): Promise<CoffeeskladStatusSyncResult> {
  const config = getCoffeeskladConfig()
  const result: CoffeeskladStatusSyncResult = {
    ok: true,
    pricesUpdated: 0,
    availabilityUpdated: 0,
    visibilityUpdated: 0,
    orderStatusesUpdated: 0,
    errors: [],
  }

  if (!isCoffeeskladReady(config)) {
    return { ...result, skipped: true, reason: "COFFESKLAD не настроен" }
  }

  const headers = { "x-api-key": config.apiKey }

  // ---------- 1. цены и наличие ----------
  try {
    const res = await fetch(`${config.baseUrl}/api/public/catalog`, { headers, signal: AbortSignal.timeout(20000) })
    if (!res.ok) throw new Error(`catalog: HTTP ${res.status}`)
    const { items } = await res.json() as { items: CatalogItem[] }
    const byBarcode = new Map(items.filter((i) => i.barcode).map((i) => [i.barcode!, i]))

    const products = await payload.find({
      collection: "products",
      limit: 1000,
      depth: 0,
      overrideAccess: true,
    })

    for (const product of products.docs) {
      let changed = false
      let anyAvailable = false
      const variants = (product.variants || []) as {
        id?: string
        name?: string
        sku?: string | null
        skuGround?: string | null
        price?: number
        isAvailable?: boolean
      }[]

      const nextVariants = variants.map((variant) => {
        // цена и остаток берём по зерновому артикулу (молотый — та же фасовка)
        const linked = (variant.sku && byBarcode.get(variant.sku))
          || (variant.skuGround && byBarcode.get(variant.skuGround))
        if (!linked) {
          if (variant.isAvailable) anyAvailable = true
          return variant
        }
        const next = { ...variant }
        const nextPrice = linked.price ?? 0
        // Наличие определяется ценой: кофе жарится под заказ, складской остаток
        // ГП в КофеСклад не ограничивает продажу на витрине.
        const nextAvailable = nextPrice > 0
        if (next.price !== nextPrice) { next.price = nextPrice; changed = true; result.pricesUpdated++ }
        if (Boolean(next.isAvailable) !== nextAvailable) {
          next.isAvailable = nextAvailable
          changed = true
          result.availabilityUpdated++
        }
        if (nextAvailable) anyAvailable = true
        return next
      })

      const nextVisible = anyAvailable
      if (Boolean(product.isVisible) !== nextVisible) {
        changed = true
        result.visibilityUpdated++
      }
      if (changed) {
        await payload.update({
          collection: "products",
          id: product.id,
          data: { variants: nextVariants, isVisible: nextVisible } as Record<string, unknown>,
          overrideAccess: true,
        })
      }
    }
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : "Не удалось синхронизировать каталог")
  }

  // ---------- 2. статусы заказов ----------
  try {
    const res = await fetch(`${config.baseUrl}/api/public/orders-status`, { headers, signal: AbortSignal.timeout(20000) })
    if (!res.ok) throw new Error(`orders-status: HTTP ${res.status}`)
    const { orders } = await res.json() as { orders: CoffeeskladOrderStatus[] }
    const byExternalId = new Map(orders.filter((o) => o.external_id).map((o) => [o.external_id, o]))

    const siteOrders = await payload.find({
      collection: "orders",
      where: { status: { not_in: ["delivered", "cancelled", "returned"] } },
      limit: 500,
      depth: 0,
      overrideAccess: true,
    })

    for (const siteOrder of siteOrders.docs) {
      const linked = byExternalId.get(String(siteOrder.id))
      if (!linked) continue
      const nextStatus = ORDER_STATUS_MAP[linked.status]
      if (!nextStatus || nextStatus === siteOrder.status) continue
      await payload.update({
        collection: "orders",
        id: siteOrder.id,
        data: { status: nextStatus } as Record<string, unknown>,
        overrideAccess: true,
      })
      result.orderStatusesUpdated++
    }
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : "Не удалось синхронизировать статусы заказов")
  }

  result.ok = result.errors.length === 0
  return result
}
