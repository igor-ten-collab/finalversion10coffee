import { NextRequest, NextResponse } from "next/server"
import { refreshYooKassaOrderPayment } from "@/lib/payments/yookassa-order-status"

export const dynamic = "force-dynamic"

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as { event?: string; object?: { id?: string } } | null
  if (!body?.object?.id || !["payment.succeeded", "payment.canceled"].includes(body.event || "")) {
    console.warn("[YooKassa webhook] Отклонено некорректное уведомление")
    return NextResponse.json({ ok: false, error: "Некорректное уведомление" }, { status: 400 })
  }
  console.log(`[YooKassa webhook] Получено ${body.event} для платежа ${body.object.id}`)
  const result = await refreshYooKassaOrderPayment(body.object.id, "payment")
  if (!result.ok) {
    console.error(`[YooKassa webhook] Платёж ${body.object.id} не обработан: ${result.error}`)
  } else {
    console.log(`[Order ${result.orderNumber || result.orderId}] Статус оплаты подтверждён: ${result.status}`)
  }
  if (result.ok && result.status === "paid" && result.moyskladSynced === false) {
    // Payment is already persisted. A non-200 response asks YooKassa to deliver
    // the notification again, letting the idempotent export recover after an outage.
    return NextResponse.json({ ok: false, error: "Не завершена выгрузка заказа в МойСклад" }, { status: 502 })
  }
  if (result.ok && result.status === "paid" && result.confirmationEmailSent === false) {
    // Ask YooKassa to retry the notification. Payment state is already stored,
    // and email delivery is idempotent, so a retry is safe.
    return NextResponse.json({ ok: false, error: "Не отправлено подтверждение оплаты" }, { status: 502 })
  }
  return NextResponse.json(result, { status: result.ok ? 200 : "retryable" in result && result.retryable ? 503 : 400 })
}
