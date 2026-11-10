// Синхронизация заказов сайта в КофеСклад (учёт обжарочного производства).
// Работает по сохранённому в Payload заказу: позиции, скидки и контакты уже
// зафиксированы в документе, поэтому выгрузка идемпотентна и безопасна при
// повторах (КофеСклад дедуплицирует по external_id).
//
// Сопоставление позиций: артикул варианта (sku / skuGround) — это штрихкод
// EAN-13 фасовки в КофеСклад. Молотый кофе выгружается артикулом skuGround.

import type { Payload } from "payload"
import { getCoffeeskladConfig, isCoffeeskladReady } from "./config"
import { DELIVERY_METHOD_LABELS } from "@/lib/utils/constants"
import type { DeliveryMethod } from "@/types"

interface StoredOrderItem {
  productId?: string | number
  productName?: string
  variantName?: string
  grindOption?: string | null
  quantity?: number | string
  unitPrice?: number | string
  totalPrice?: number | string
  discountPercent?: number | string | null
  discountAmount?: number | string | null
}

interface StoredOrder {
  id: string | number
  orderId?: string
  salesChannel?: string | null
  customerType?: string | null
  customerFullName?: string | null
  customerEmail?: string | null
  customerPhone?: string | null
  companyName?: string | null
  companyInn?: string | null
  deliveryMethod?: DeliveryMethod | null
  deliveryAddress?: string | null
  deliveryCost?: number | string | null
  comment?: string | null
  status?: string | null
  paymentStatus?: string | null
  coffeeskladSyncStatus?: string | null
  coffeeskladOrderNumber?: string | null
  items?: StoredOrderItem[]
}

interface VariantDoc {
  id?: string | number
  name?: string
  sku?: string | null
  skuGround?: string | null
}

interface ProductDoc {
  id?: string | number
  name?: string
  variants?: VariantDoc[]
}

export interface CoffeeskladSyncResult {
  success?: boolean
  skipped?: boolean
  duplicate?: boolean
  error?: string
  orderNumber?: string
  unmatchedItems?: string[]
}

function numberValue(value: unknown) {
  return Number(value) || 0
}

function round2(value: number) {
  return Math.round(value * 100) / 100
}

function normalizeText(value?: string | null) {
  return (value || "").trim().toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ")
}

function normalizeGrind(value?: string | null) {
  const normalized = normalizeText(value)
  if (!normalized) return ""
  if (normalized === "beans" || normalized.includes("зерн")) return "beans"
  if (normalized === "ground" || normalized.includes("молот")) return "ground"
  return normalized
}

function lineDiscountedUnitPrice(item: StoredOrderItem) {
  const qty = numberValue(item.quantity) || 1
  const unitPrice = numberValue(item.unitPrice)
  const totalPrice = numberValue(item.totalPrice) || unitPrice * qty
  const discountAmount = numberValue(item.discountAmount)
  if (discountAmount > 0) return round2(Math.max(0, totalPrice - discountAmount) / qty)
  const discountPercent = Math.max(0, Math.min(100, numberValue(item.discountPercent)))
  if (discountPercent > 0) return round2(unitPrice * (1 - discountPercent / 100))
  return round2(unitPrice)
}

async function loadProductsByIds(payload: Payload, ids: string[]) {
  const result = new Map<string, ProductDoc>()
  if (ids.length === 0) return result
  const found = await payload.find({
    collection: "products",
    where: { id: { in: ids } },
    limit: 100,
    depth: 0,
    overrideAccess: true,
  })
  for (const doc of found.docs as ProductDoc[]) {
    if (doc.id != null) result.set(String(doc.id), doc)
  }
  return result
}

function resolveVariant(product: ProductDoc | undefined, item: StoredOrderItem): VariantDoc | undefined {
  const variants = product?.variants || []
  if (variants.length === 0) return undefined
  const target = normalizeText(item.variantName)
  const exact = variants.find((v) => normalizeText(v.name) === target)
  if (exact) return exact
  return variants.find((v) => {
    const name = normalizeText(v.name)
    return name && target && (name.includes(target) || target.includes(name))
  })
}

async function resolveVatRate(payload: Payload) {
  try {
    const siteSettings = await payload.findGlobal({ slug: "site-settings", overrideAccess: true })
    const vat = Number((siteSettings as { vatPercent?: number | string }).vatPercent)
    if (Number.isFinite(vat) && vat >= 0) return vat
  } catch {
    // нет настройки — используем ставку по умолчанию
  }
  return 22
}

/**
 * Выгружает сохранённый заказ в КофеСклад. Никогда не бросает исключение:
 * ошибка фиксируется в полях заказа и возвращается в результате.
 */
export async function syncOrderToCoffeeskladById(
  payload: Payload,
  orderId: string | number,
): Promise<CoffeeskladSyncResult> {
  const config = getCoffeeskladConfig()
  if (!isCoffeeskladReady(config)) return { skipped: true }

  let order: StoredOrder
  try {
    order = await payload.findByID({
      collection: "orders",
      id: orderId,
      depth: 0,
      overrideAccess: true,
    }) as StoredOrder
  } catch {
    return { error: "Заказ не найден" }
  }

  if (order.status === "cancelled") return { skipped: true }
  const items = order.items || []
  if (items.length === 0) return { error: "В заказе нет позиций" }

  const updateOrder = async (data: Record<string, unknown>) => {
    await payload.update({
      collection: "orders",
      id: orderId,
      data,
      overrideAccess: true,
    }).catch(() => {})
  }

  try {
    await updateOrder({ coffeeskladSyncStatus: "pending", coffeeskladSyncError: "" })

    const productIds = [...new Set(items.map((item) => String(item.productId || "")).filter(Boolean))]
    const products = await loadProductsByIds(payload, productIds)
    const vatRate = await resolveVatRate(payload)

    const webhookItems = items.map((item) => {
      const product = products.get(String(item.productId || ""))
      const variant = resolveVariant(product, item)
      const grind = normalizeGrind(item.grindOption)
      const sku = grind === "ground"
        ? (variant?.skuGround || variant?.sku || "")
        : (variant?.sku || "")
      const productName = item.productName || product?.name || "Товар"
      const variantName = item.variantName || variant?.name || ""
      const grindLabel = grind === "ground" ? ", молотый" : ""
      return {
        code: String(sku || "").trim(),
        name: `${productName} ${variantName}${grindLabel}`.trim(),
        qty: numberValue(item.quantity),
        price: lineDiscountedUnitPrice(item),
        vat_rate: vatRate,
      }
    })

    const deliveryLabel = order.deliveryMethod
      ? DELIVERY_METHOD_LABELS[order.deliveryMethod] || order.deliveryMethod
      : ""
    const deliveryCost = numberValue(order.deliveryCost)
    const delivery = [
      deliveryLabel,
      deliveryCost > 0 ? `${deliveryCost} ₽` : "",
      order.deliveryAddress || "",
    ].filter(Boolean).join(", ")

    const isBusiness = order.customerType === "business" || Boolean(order.companyName)
    const body = {
      external_id: String(order.id),
      // Номер заказа сайта (10C-…): КофеСклад сохраняет его как номер заказа,
      // чтобы нумерация на сайте и в учёте совпадала.
      number: order.orderId ? String(order.orderId) : undefined,
      customer: {
        name: (isBusiness ? order.companyName : order.customerFullName) || order.customerFullName || "Покупатель 10coffee",
        inn: isBusiness ? (order.companyInn || "") : "",
        phone: order.customerPhone || "",
        email: order.customerEmail || "",
        address: order.deliveryAddress || "",
      },
      delivery,
      comment: [
        `Заказ сайта ${order.orderId || order.id}`,
        isBusiness ? "" : "Розничный заказ (интернет-магазин)",
        order.comment ? `Комментарий покупателя: ${order.comment}` : "",
      ].filter(Boolean).join("\n"),
      items: webhookItems,
    }

    const response = await fetch(`${config.baseUrl}/api/public/order`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "x-api-key": config.apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    })
    const result = await response.json().catch(() => null) as {
      id?: number
      number?: string
      duplicate?: boolean
      unmatched_items?: string[]
      error?: string
    } | null

    if (!response.ok) {
      throw new Error(result?.error || `КофеСклад ответил HTTP ${response.status}`)
    }

    await updateOrder({
      coffeeskladSyncStatus: "synced",
      coffeeskladOrderNumber: result?.number || "",
      coffeeskladSyncedAt: new Date().toISOString(),
      coffeeskladSyncError: "",
    })

    if (result?.unmatched_items?.length) {
      console.warn(
        `[Coffeesklad] Заказ ${order.orderId || order.id} выгружен (${result.number}), ` +
        `но позиции не распознаны: ${result.unmatched_items.join(", ")}`,
      )
    }

    return {
      success: true,
      duplicate: Boolean(result?.duplicate),
      orderNumber: result?.number,
      unmatchedItems: result?.unmatched_items,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Не удалось выгрузить заказ в КофеСклад"
    await updateOrder({ coffeeskladSyncStatus: "error", coffeeskladSyncError: message })
    console.error(`[Coffeesklad] Заказ ${order.orderId || order.id}: ошибка выгрузки — ${message}`)
    return { error: message }
  }
}
