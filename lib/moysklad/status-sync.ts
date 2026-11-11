import type { Payload } from "payload"
import { getMoyskladConfig } from "./config"
import { moyskladRequest } from "./client"
import { writeMoyskladLog } from "./logs"
import { createAdminClient } from "@/lib/supabase/admin"
import type { MoyskladCustomerOrder } from "./types"
import type { OrderStatus } from "@/types"
import { getPool } from "@/lib/db"
import { assertRemoteOrderIdentity, assertRemoteOrderTotalsConsistent } from "./order-identity"

type PaymentStatus = "pending" | "invoiced" | "partial" | "paid" | "refunded" | "cancelled" | "failed"

interface PayloadClientForStatus {
  id?: string | number
  supabaseId?: string | null
}

interface PayloadOrderForStatus {
  id: string | number
  orderId?: string
  status?: OrderStatus
  paymentStatus?: PaymentStatus
  customerType?: string
  salesChannel?: string
  paymentMethod?: string
  moyskladCustomerOrderId?: string | null
  moyskladCounterpartyId?: string | null
  client?: PayloadClientForStatus | string | number | null
}

interface SyncOrderStatusOptions {
  /** Page size, not a cap on the number of orders checked. */
  limit?: number
  orderIds?: (string | number)[]
}

interface SyncedOrderStatus {
  id: string | number
  orderId?: string
  moyskladCustomerOrderId: string
  status: OrderStatus
  paymentStatus: PaymentStatus
  moyskladState?: string | null
}

const STATUS_LABELS: Record<OrderStatus, string> = {
  new: "Новый",
  confirmed: "Подтвержден",
  invoiced: "Счет выставлен",
  paid: "Оплачен",
  in_production: "В производстве",
  ready: "Собран",
  shipped: "Отгружен",
  delivered: "Доставлен",
  returned: "Возврат",
  cancelled: "Отменен",
}

function normalizeStateName(value?: string | null) {
  return (value || "").trim().toLowerCase().replace(/ё/g, "е")
}

export function mapMoyskladStateToOrderStatus(stateName?: string | null): OrderStatus | null {
  const state = normalizeStateName(stateName)

  if (!state) return null
  if (state.includes("отмен")) return "cancelled"
  if (state.includes("возврат")) return "returned"
  if (state.includes("собран")) return "ready"
  if (state.includes("достав")) return "delivered"
  if (state.includes("отгруж")) return "shipped"
  if (state.includes("готов")) return "ready"
  if (state.includes("производ")) return "in_production"
  if (state.includes("оплачен")) return "paid"
  if (state.includes("счет") || state.includes("счёт")) return "invoiced"
  if (state.includes("подтверж")) return "confirmed"
  if (state.includes("нов")) return "new"

  return null
}

async function notifyClientAboutStatus(order: PayloadOrderForStatus, status: OrderStatus) {
  const client = order.client
  const clientId = typeof client === "object" && client !== null ? client.supabaseId : null
  if (!clientId) return

  const orderDisplayId = order.orderId || String(order.id)
  const statusLabel = STATUS_LABELS[status] || status
  const adminDb = createAdminClient()

  const { error } = await adminDb.from("notifications").insert({
    client_id: clientId,
    type: "order_update",
    title: "Статус заказа изменен",
    message: `Заказ ${orderDisplayId}: ${statusLabel}`,
    data: {
      order_id: String(order.id),
      status,
      source: "moysklad",
    },
  })

  if (error) {
    throw new Error(`Не удалось создать уведомление о статусе: ${error.message}`)
  }
}

function mapMoyskladPaymentStatus(order: MoyskladCustomerOrder, status: OrderStatus): PaymentStatus {
  const sum = Number(order.sum) || 0
  const payedSum = Number(order.payedSum) || 0
  const invoicedSum = Number(order.invoicedSum) || 0

  if (sum > 0 && payedSum >= sum) return "paid"
  if (payedSum > 0) return "partial"
  if (invoicedSum > 0) return "invoiced"
  if (status === "invoiced") return "invoiced"

  return "pending"
}

async function fetchMoyskladOrder(id: string) {
  return moyskladRequest<MoyskladCustomerOrder>(`entity/customerorder/${id}?expand=state`)
}

export async function syncMoyskladOrderStatuses(
  payload: Payload,
  options: SyncOrderStatusOptions = {}
) {
  const config = getMoyskladConfig()
  if (!config.enabled) {
    return { ok: false as const, error: "MOYSKLAD_ENABLED не включен" }
  }

  // Admin, Docker, CLI and an external cron may run at the same time.
  // One database lock prevents duplicate notifications across all instances.
  const client = await getPool().connect()
  const lockKey = "moysklad-order-status-sync"
  let locked = false
  try {
    const result = await client.query<{ locked: boolean }>(
      "select pg_try_advisory_lock(hashtext($1)) as locked", [lockKey],
    )
    locked = result.rows[0]?.locked === true
    if (!locked) return { ok: true as const, skipped: true, checked: 0, synced: 0, errors: [], orders: [] }
    return await syncLinkedMoyskladOrderStatuses(payload, options)
  } finally {
    if (locked) {
      await client.query("select pg_advisory_unlock(hashtext($1))", [lockKey]).catch(() => undefined)
    }
    client.release()
  }
}

async function syncLinkedMoyskladOrderStatuses(payload: Payload, options: SyncOrderStatusOptions) {
  const limit = options.limit || 200
  const orders: PayloadOrderForStatus[] = []
  let page = 1
  while (true) {
    const result = await payload.find({
      collection: "orders",
      where: {
        and: [
          { moyskladCustomerOrderId: { exists: true } },
          { moyskladCustomerOrderId: { not_equals: "" } },
          ...(options.orderIds ? [{ id: { in: options.orderIds } }] : []),
        ],
      },
      sort: "id",
      limit,
      page,
      depth: 1,
      overrideAccess: true,
    })
    orders.push(...(result.docs as PayloadOrderForStatus[])
      .filter((order) => Boolean(order.moyskladCustomerOrderId)))
    if (!result.hasNextPage) break
    page = result.nextPage || page + 1
  }

  const synced: SyncedOrderStatus[] = []
  const errors: { id: string | number; orderId?: string; error: string }[] = []

  for (const order of orders) {
    const moyskladCustomerOrderId = order.moyskladCustomerOrderId
    if (!moyskladCustomerOrderId) continue

    try {
      const moyskladOrder = await fetchMoyskladOrder(moyskladCustomerOrderId)
      const channel = order.salesChannel === "retail" || (!order.salesChannel && order.customerType === "individual") ? "retail" : "wholesale"
      assertRemoteOrderIdentity(moyskladOrder, order, getMoyskladConfig(channel).organizationId, order.moyskladCounterpartyId)
      assertRemoteOrderTotalsConsistent(moyskladOrder, { allowPaidOverage: true })
      const nextStatus = mapMoyskladStateToOrderStatus(moyskladOrder.state?.name)
      if (!nextStatus) {
        throw new Error(`Неизвестный статус МойСклад: ${moyskladOrder.state?.name || "не указан"}`)
      }
      // Retail payment is confirmed by the payment provider. MoySklad can have
      // no incoming payment document even after YooKassa confirms payment.
      const preservePayment = order.salesChannel === "retail" || (!order.salesChannel && order.customerType === "individual")
        || order.paymentMethod === "yookassa" || order.paymentMethod === "sber_online"
      const nextPaymentStatus = preservePayment
        ? order.paymentStatus || "pending"
        : mapMoyskladPaymentStatus(moyskladOrder, nextStatus)
      const statusChanged = nextStatus !== order.status

      await payload.update({
        collection: "orders",
        id: order.id,
        data: {
          status: nextStatus,
          ...(!preservePayment ? { paymentStatus: nextPaymentStatus } : {}),
          moyskladSyncStatus: "synced",
          moyskladSyncError: "",
          moyskladSyncedAt: new Date().toISOString(),
        },
        overrideAccess: true,
        context: { moyskladStatusSync: true },
      })

      if (statusChanged) {
        try {
          await notifyClientAboutStatus(order, nextStatus)
        } catch (notificationError) {
          await writeMoyskladLog({
            entityType: "order_status",
            localId: order.id,
            moyskladId: moyskladCustomerOrderId,
            direction: "moysklad_to_site",
            status: "error",
            message: notificationError instanceof Error
              ? notificationError.message
              : "Не удалось создать уведомление о статусе",
          })
        }
      }

      synced.push({
        id: order.id,
        orderId: order.orderId,
        moyskladCustomerOrderId,
        status: nextStatus,
        paymentStatus: nextPaymentStatus,
        moyskladState: moyskladOrder.state?.name || null,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Не удалось синхронизировать статус заказа"
      errors.push({ id: order.id, orderId: order.orderId, error: message })

      await payload.update({
        collection: "orders",
        id: order.id,
        data: {
          moyskladSyncStatus: "error",
          moyskladSyncError: message,
        },
        overrideAccess: true,
      })

      await writeMoyskladLog({
        entityType: "order_status",
        localId: order.id,
        moyskladId: moyskladCustomerOrderId,
        direction: "moysklad_to_site",
        status: "error",
        message,
      })
    }
  }

  if (synced.length > 0) {
    await writeMoyskladLog({
      entityType: "order_status",
      direction: "moysklad_to_site",
      status: "success",
      message: `Синхронизировано статусов заказов: ${synced.length}`,
      response: synced,
    })
  }

  return {
    ok: errors.length === 0,
    checked: orders.length,
    synced: synced.length,
    errors,
    orders: synced,
  }
}
