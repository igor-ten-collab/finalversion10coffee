import { createHash } from "node:crypto"
import type { YooKassaReceiptItem } from "@/lib/payments/yookassa-receipt"

const YOOKASSA_API_URL = "https://api.yookassa.ru/v3"

export interface YooKassaConfig { enabled: boolean; shopId: string; secretKey: string; returnUrl: string; webhookUrl: string }
interface YooKassaSettings { enabled?: boolean; shopId?: string; secretKey?: string; returnUrl?: string; webhookUrl?: string }
export type YooKassaPaymentStatus = "pending" | "paid" | "cancelled" | "refunded" | "failed"
interface YooKassaPayment {
  id?: string
  status?: "pending" | "waiting_for_capture" | "succeeded" | "canceled"
  amount?: { value?: string; currency?: string }
  confirmation?: { confirmation_url?: string }
  metadata?: { order_id?: string; order_number?: string }
}

export async function getYooKassaConfig(): Promise<YooKassaConfig> {
  let settings: YooKassaSettings | null = null
  try {
    const [{ getPayload }, { default: payloadConfig }] = await Promise.all([import("payload"), import("@payload-config")])
    settings = await (await getPayload({ config: payloadConfig })).findGlobal({ slug: "payment-settings", overrideAccess: true }) as unknown as YooKassaSettings
  } catch (error) {
    // Environment variables keep deploys operable before Payload is initialized.
    console.error(
      "Не удалось прочитать настройки YooKassa из Payload:",
      error instanceof Error ? error.message : "неизвестная ошибка",
    )
  }
  return {
    enabled: settings?.enabled ?? process.env.YOOKASSA_ENABLED === "true",
    shopId: (settings?.shopId || process.env.YOOKASSA_SHOP_ID || "").trim(),
    secretKey: (settings?.secretKey || process.env.YOOKASSA_SECRET_KEY || "").trim(),
    returnUrl: (settings?.returnUrl || process.env.YOOKASSA_RETURN_URL || "https://shop.10coffee.ru/order/success").trim(),
    webhookUrl: (settings?.webhookUrl || process.env.YOOKASSA_WEBHOOK_URL || "https://shop.10coffee.ru/api/shop/payments/yookassa/webhook").trim(),
  }
}

export function isYooKassaReady(config: YooKassaConfig) {
  return Boolean(config.enabled && config.shopId && config.secretKey && config.returnUrl)
}

async function yooKassaRequest<T>(path: string, config: YooKassaConfig, init?: RequestInit): Promise<T> {
  const response = await fetch(`${YOOKASSA_API_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.shopId}:${config.secretKey}`).toString("base64")}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
    cache: "no-store",
    ...((!init?.method || init.method === "GET") ? { signal: init?.signal || AbortSignal.timeout(20000) } : {}),
  })
  const result = await response.json().catch(() => null) as (T & { description?: string }) | null
  if (!response.ok || !result) throw new Error(result?.description || `YooKassa вернула HTTP ${response.status}`)
  return result
}

export async function createYooKassaPayment(params: {
  orderId: string
  orderNumber: string
  amountRubles: number
  customerEmail: string
  receiptItems: YooKassaReceiptItem[]
  description?: string
  attemptKey?: string
}) {
  const config = await getYooKassaConfig()
  if (!isYooKassaReady(config)) return { ok: false as const, code: "not_configured" as const, error: "Онлайн-оплата YooKassa пока не подключена" }
  if (!Number.isFinite(params.amountRubles) || params.amountRubles <= 0) return { ok: false as const, code: "invalid_amount" as const, error: "Некорректная сумма платежа" }
  const receiptTotal = params.receiptItems.reduce((sum, item) => sum + item.amountRubles, 0)
  if (!params.customerEmail || params.receiptItems.length === 0 || Math.abs(receiptTotal - params.amountRubles) > 0.001) {
    return { ok: false as const, code: "invalid_receipt" as const, error: "Некорректные данные фискального чека" }
  }

  const returnUrl = new URL(config.returnUrl)
  returnUrl.searchParams.set("orderId", params.orderId)
  const idempotenceKey = createHash("sha256").update(`10coffee:${params.orderId}:${params.attemptKey || "create"}`).digest("hex")
  try {
    const payment = await yooKassaRequest<YooKassaPayment>("/payments", config, {
      method: "POST",
      headers: { "Idempotence-Key": idempotenceKey },
      body: JSON.stringify({
        amount: { value: params.amountRubles.toFixed(2), currency: "RUB" },
        capture: true,
        confirmation: { type: "redirect", return_url: returnUrl.toString() },
        description: params.description?.slice(0, 128),
        metadata: { order_id: params.orderId, order_number: params.orderNumber },
        receipt: {
          customer: { email: params.customerEmail },
          items: params.receiptItems.map((item) => ({
            description: item.description,
            quantity: 1,
            amount: { value: item.amountRubles.toFixed(2), currency: "RUB" },
            vat_code: item.vatCode,
            payment_mode: "full_prepayment",
            payment_subject: item.paymentSubject,
          })),
          internet: true,
        },
      }),
    })
    if (!payment.id || !payment.confirmation?.confirmation_url) return { ok: false as const, code: "api_error" as const, error: "YooKassa не вернула ссылку на оплату" }
    return { ok: true as const, paymentId: payment.id, paymentUrl: payment.confirmation.confirmation_url }
  } catch (error) {
    return { ok: false as const, code: "api_error" as const, error: error instanceof Error ? error.message : "Не удалось создать платёж YooKassa" }
  }
}

export async function getYooKassaPayment(paymentId: string) {
  const config = await getYooKassaConfig()
  if (!isYooKassaReady(config)) return { ok: false as const, error: "YooKassa не подключена" }
  try {
    const payment = await yooKassaRequest<YooKassaPayment>(`/payments/${encodeURIComponent(paymentId)}`, config)
    const statusMap: Record<string, YooKassaPaymentStatus> = { pending: "pending", waiting_for_capture: "pending", succeeded: "paid", canceled: "cancelled" }
    if (!payment.id || !payment.status || !statusMap[payment.status]) {
      return { ok: false as const, error: "YooKassa вернула неизвестный статус или некорректный ID платежа" }
    }
    return {
      ok: true as const,
      paymentId: payment.id || paymentId,
      paymentUrl: payment.confirmation?.confirmation_url,
      status: statusMap[payment.status || ""] || "failed",
      amountRubles: Number(payment.amount?.value),
      currency: payment.amount?.currency,
      orderId: payment.metadata?.order_id,
      orderNumber: payment.metadata?.order_number,
    }
  } catch (error) {
    return { ok: false as const, error: error instanceof Error ? error.message : "Не удалось проверить платёж" }
  }
}
