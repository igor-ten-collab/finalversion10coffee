// Отмена/восстановление заказа в КофеСклад при смене статуса на сайте.
// Транспорт и конфиг — те же, что у выгрузки заказов (lib/coffeesklad/sync.ts):
// POST /api/public/order-cancel с ключом x-api-key, таймаут 15 с.
// Функция никогда не бросает исключение: ошибка фиксируется в поле заказа
// coffeeskladSyncError и возвращается в результате.

import type { Payload } from "payload"
import { getCoffeeskladConfig, isCoffeeskladReady } from "./config"

export type CoffeeskladCancelAction = "cancel" | "restore"

export interface CoffeeskladCancelResult {
  success?: boolean
  skipped?: boolean
  already?: boolean
  error?: string
  orderNumber?: string
}

interface CancelOrderRef {
  id: string | number
  orderId?: string | null
}

/**
 * Отправляет в КофеСклад отмену (cancel) или восстановление (restore) заказа.
 * Идемпотентно: повторная отмена и restore активного заказа — успешный noop.
 */
export async function cancelOrderInCoffeesklad(
  payload: Payload,
  order: CancelOrderRef,
  action: CoffeeskladCancelAction = "cancel",
): Promise<CoffeeskladCancelResult> {
  const config = getCoffeeskladConfig()
  if (!isCoffeeskladReady(config)) return { skipped: true }

  const label = action === "cancel" ? "отмена" : "восстановление"
  const notDelivered = action === "cancel"
    ? "Отмена не доставлена в КофеСклад"
    : "Восстановление не доставлено в КофеСклад"

  // Обновление заказа только служебным полем ошибки. Контекст-флаг
  // (паттерн req.context?.moyskladStatusSync) не даёт хукам Orders
  // среагировать на это обновление и устроить рекурсию.
  const writeError = async (message: string) => {
    await payload.update({
      collection: "orders",
      id: order.id,
      data: { coffeeskladSyncError: message },
      context: { coffeeskladCancelSync: true },
      overrideAccess: true,
    }).catch(() => {})
  }

  try {
    const response = await fetch(`${config.baseUrl}/api/public/order-cancel`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "x-api-key": config.apiKey,
      },
      body: JSON.stringify({ external_id: String(order.id), action }),
      signal: AbortSignal.timeout(15000),
    })
    const result = await response.json().catch(() => null) as {
      ok?: boolean
      already?: boolean
      code?: string
      number?: string
      error?: string
    } | null

    // Заказа в КофеСклад нет — отменять нечего, успешный noop.
    if (response.status === 404) {
      return { success: true, already: true }
    }

    // Отгруженный заказ: автоматическая отмена запрещена, нужен менеджер.
    if (response.status === 409 || result?.code === "shipped") {
      const message = `КофеСклад: заказ отгружен, ${label} только вручную менеджером (№${result?.number || "?"})`
      await writeError(message)
      console.error(`[Coffeesklad] Заказ ${order.orderId || order.id}: ${message}`)
      return { error: message, orderNumber: result?.number }
    }

    if (!response.ok) {
      const message = `${notDelivered}: ${result?.error || `КофеСклад ответил HTTP ${response.status}`}`
      await writeError(message)
      console.error(`[Coffeesklad] Заказ ${order.orderId || order.id}: ${message}`)
      return { error: message }
    }

    // Успех (в т.ч. повтор — already): снимаем ранее записанную ошибку.
    await writeError("")
    return { success: true, already: Boolean(result?.already), orderNumber: result?.number }
  } catch (error) {
    const message = `${notDelivered}: ${error instanceof Error ? error.message : "сетевая ошибка"}`
    await writeError(message)
    console.error(`[Coffeesklad] Заказ ${order.orderId || order.id}: ${message}`)
    return { error: message }
  }
}
