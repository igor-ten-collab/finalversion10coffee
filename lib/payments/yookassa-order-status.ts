import { getPayload } from "payload"
import config from "@payload-config"
import { getYooKassaPayment } from "@/lib/payments/yookassa"
import { sendPaidOrderConfirmation } from "@/lib/payments/paid-order-email"
import { syncOrderToMoyskladById } from "@/lib/moysklad/order-retry"
import { syncOrderToCoffeeskladById } from "@/lib/coffeesklad/sync"
import { finalizeLoyaltyForPaidOrder, releaseLoyaltyReservation } from "@/lib/loyalty"
import { createYandexDeliveryRequestForPaidOrder } from "@/lib/yandex-delivery"
import { getPool } from "@/lib/db"
import { clearPaidOrderCart } from "@/lib/payments/paid-order-cart"
import { getMoyskladConfig } from "@/lib/moysklad/config"

export async function refreshYooKassaOrderPayment(reference: string, referenceKind: "order" | "payment" = "payment") {
  const normalized = reference.trim()
  if (!normalized) return { ok: false as const, error: "Не указан ID заказа или платежа" }
  const payload = await getPayload({ config })
  const orders = await payload.find({
    collection: "orders",
    where: referenceKind === "payment" ? { paymentExternalId: { equals: normalized } }
      : /^[1-9]\d*$/.test(normalized) ? { id: { equals: Number(normalized) } } : { orderId: { equals: normalized } },
    limit: 1, depth: 0, overrideAccess: true,
  })
  const initialOrder = orders.docs[0]
  if (!initialOrder || !initialOrder.paymentExternalId) return { ok: false as const, error: "Заказ для платежа не найден" }
  const lockClient = await getPool().connect()
  const lockKey = `yookassa-payment:${initialOrder.paymentExternalId}`
  let locked = false
  try {
    const lock = await lockClient.query<{ locked: boolean }>("select pg_try_advisory_lock(hashtext($1)) as locked", [lockKey])
    locked = lock.rows[0]?.locked === true
    if (!locked) return { ok: false as const, retryable: true, error: "Платёж уже обрабатывается. Повторите проверку позже." }
    // Webhooks, return pages and the automatic reconciliation share the lock.
    // Re-read inside it so an older request cannot use a stale payment attempt.
    const order = await payload.findByID({ collection: "orders", id: initialOrder.id, depth: 0, overrideAccess: true })
    if (order.paymentExternalId !== initialOrder.paymentExternalId) return { ok: false as const, error: "Платёжная попытка заказа изменилась" }
    const payment = await getYooKassaPayment(order.paymentExternalId)
    if (!payment.ok) return payment
    if (payment.paymentId !== order.paymentExternalId || payment.orderId !== String(order.id)
      || payment.orderNumber !== order.orderId) return { ok: false as const, error: "Платёж не принадлежит этому заказу" }
    if (payment.currency !== "RUB") return { ok: false as const, error: "Валюта платежа не совпадает с валютой заказа" }
    if (!Number.isFinite(payment.amountRubles) || Math.abs(payment.amountRubles - Number(order.total || 0)) > 0.01) return { ok: false as const, error: "Сумма платежа не совпадает с суммой заказа" }
    if (order.paymentStatus === "paid" && payment.status !== "paid") return { ok: false as const, error: "Получен неподтверждённый статус для уже оплаченного заказа. Требуется повторная сверка YooKassa" }
    const paymentIsTerminalFailure = ["cancelled", "failed"].includes(payment.status)
    await payload.update({
      collection: "orders",
      id: order.id,
      data: {
        paymentStatus: payment.status,
        paymentUpdatedAt: new Date().toISOString(),
        ...(paymentIsTerminalFailure ? { status: "cancelled" } : {}),
      },
      overrideAccess: true,
    })
    // Export independently of cart, loyalty and delivery side effects: a failure
    // in those systems must not prevent a paid order from reaching MoySklad.
    let moyskladSynced: boolean | null = null
    let moyskladError: string | null = null
    if (payment.status === "paid" && (order.moyskladSyncStatus !== "synced" || !order.moyskladCustomerOrderId)) {
      try {
        const sync = await syncOrderToMoyskladById(payload, order.id)
        if ("error" in sync && sync.error) {
          moyskladSynced = false
          moyskladError = sync.error
          console.error(`[Order ${order.orderId || order.id}] Не удалось выгрузить оплаченный заказ в МойСклад: ${sync.error}`)
        } else if ("skipped" in sync && sync.skipped) {
          moyskladSynced = null
        } else {
          moyskladSynced = true
        }
      } catch (error) {
        moyskladSynced = false
        moyskladError = error instanceof Error ? error.message : "Не удалось выгрузить оплаченный заказ в МойСклад"
        console.error(`[Order ${order.orderId || order.id}] Не удалось выгрузить оплаченный заказ в МойСклад: ${moyskladError}`)
      }
    }
    // Оплаченный розничный заказ уходит в КофеСклад независимо от выгрузки в
    // МойСклад: ошибка одной системы не блокирует другую.
    let coffeeskladSynced: boolean | null = null
    let coffeeskladError: string | null = null
    if (payment.status === "paid" && (order as { coffeeskladSyncStatus?: string | null }).coffeeskladSyncStatus !== "synced") {
      const sync = await syncOrderToCoffeeskladById(payload, order.id)
      if (sync.error) {
        coffeeskladSynced = false
        coffeeskladError = sync.error
        console.error(`[Order ${order.orderId || order.id}] Не удалось выгрузить оплаченный заказ в КофеСклад: ${sync.error}`)
      } else if (sync.skipped) {
        coffeeskladSynced = null
      } else {
        coffeeskladSynced = true
      }
    }
    if (payment.status === "paid" && !order.cartClearedAt) {
      const cartCleanup = await clearPaidOrderCart(payload, order, {
        allowLegacyFullClear: order.paymentStatus !== "paid",
      })
      if (!cartCleanup.cleared && !cartCleanup.skipped) {
        console.error(`[Order ${order.orderId || order.id}] Не удалось очистить оплаченную корзину: ${cartCleanup.error}`)
      }
    }
    if (payment.status === "paid") await finalizeLoyaltyForPaidOrder(payload, order as unknown as Record<string, unknown>)
    if (["cancelled", "failed", "refunded"].includes(payment.status)) await releaseLoyaltyReservation(payload, order.id)
    let yandexDeliveryCreated: boolean | null = null
    let yandexDeliveryError: string | null = null
    if (payment.status === "paid" && order.deliveryMethod === "yandex_delivery" && !order.yandexRequestId) {
      const client = await getPool().connect()
      const lockKey = `yandex-delivery:${order.id}`
      try {
        // A webhook and the return page can reach this code at the same time.
        // Hold a per-order lock until the external request ID is persisted.
        await client.query("select pg_advisory_lock(hashtext($1))", [lockKey])
        const current = await client.query<{ yandex_request_id: string | null }>(
          "select yandex_request_id from orders where id = $1",
          [order.id],
        )
        if (!current.rows[0]?.yandex_request_id) {
          const yandex = await createYandexDeliveryRequestForPaidOrder(order)
          if (!yandex.skipped && yandex.requestId) {
            await payload.update({
              collection: "orders",
              id: order.id,
              data: { yandexRequestId: yandex.requestId, yandexDeliveryStatus: "Заявка создана" },
              overrideAccess: true,
            })
            yandexDeliveryCreated = true
          }
        }
      } catch (error) {
        yandexDeliveryCreated = false
        yandexDeliveryError = error instanceof Error ? error.message : "Не удалось создать заявку Яндекс Доставки"
        await payload.update({
          collection: "orders",
          id: order.id,
          data: { yandexDeliveryStatus: `Ошибка: ${yandexDeliveryError}`.slice(0, 500) },
          overrideAccess: true,
        })
        console.error(`[Order ${order.orderId || order.id}] Не удалось создать заявку Яндекс Доставки: ${yandexDeliveryError}`)
      } finally {
        await client.query("select pg_advisory_unlock(hashtext($1))", [lockKey]).catch(() => undefined)
        client.release()
      }
    }
    const email = payment.status === "paid"
      ? await sendPaidOrderConfirmation(payload, order.id)
      : null
    if (email && !email.sent) {
      console.error(`[Order ${order.orderId || order.id}] Не отправлено письмо об оплате: ${email.error}`)
    }
    return {
      ok: true as const,
      orderId: order.id,
      orderNumber: order.orderId,
      status: payment.status,
      confirmationEmailSent: email?.sent ?? null,
      moyskladSynced,
      moyskladError,
      coffeeskladSynced,
      coffeeskladError,
      yandexDeliveryCreated,
      yandexDeliveryError,
    }
  } finally {
    if (locked) await lockClient.query("select pg_advisory_unlock(hashtext($1))", [lockKey]).catch(() => undefined)
    lockClient.release()
  }
}

export async function reconcilePendingYooKassaPayments() {
  const payload = await getPayload({ config })
  const lockClient = await getPool().connect()
  const lockKey = "yookassa-payment-reconciliation"
  let locked = false
  try {
    const lock = await lockClient.query<{ locked: boolean }>("select pg_try_advisory_lock(hashtext($1)) as locked", [lockKey])
    locked = lock.rows[0]?.locked === true
    if (!locked) return { checked: 0, updated: 0, errors: [], skipped: true }
    const paymentIds: string[] = []
    const moyskladConfig = getMoyskladConfig()
    const retryPaidExports = moyskladConfig.enabled && moyskladConfig.syncOrdersOnCreate
    let page = 1
    while (true) {
      const orders = await payload.find({
        collection: "orders",
        where: {
          and: [
            { paymentMethod: { equals: "yookassa" } },
            { paymentExternalId: { exists: true } },
            { paymentExternalId: { not_equals: "" } },
            { or: [
              { paymentStatus: { equals: "pending" } },
              // A confirmed payment whose first export failed also needs a
              // retry when no webhook is available. Do not rewrite linked history.
              ...(retryPaidExports ? [{ and: [
                { paymentStatus: { equals: "paid" } },
                { moyskladSyncStatus: { in: ["pending", "error"] } },
                { or: [{ moyskladCustomerOrderId: { exists: false } }, { moyskladCustomerOrderId: { equals: "" } }] },
              ] }] : []),
            ] },
          ],
        },
        limit: 200,
        sort: "-createdAt",
        page,
        depth: 0,
        overrideAccess: true,
      })
      for (const order of orders.docs) {
        if (order.paymentExternalId) paymentIds.push(order.paymentExternalId)
      }
      if (!orders.hasNextPage) break
      page = orders.nextPage || page + 1
    }

    let updated = 0
    const errors: string[] = []
    for (const paymentId of paymentIds) {
      try {
        const result = await refreshYooKassaOrderPayment(paymentId, "payment")
        if (result.ok) {
          if (result.status !== "pending") updated += 1
          if (result.moyskladSynced === false) errors.push(`${paymentId}: ${result.moyskladError || "Не завершена выгрузка в МойСклад"}`)
        } else {
          errors.push(`${paymentId}: ${result.error}`)
        }
      } catch (error) {
        errors.push(`${paymentId}: ${error instanceof Error ? error.message : "Ошибка проверки платежа"}`)
      }
    }
    return { checked: paymentIds.length, updated, errors }
  } finally {
    if (locked) await lockClient.query("select pg_advisory_unlock(hashtext($1))", [lockKey]).catch(() => undefined)
    lockClient.release()
  }
}
