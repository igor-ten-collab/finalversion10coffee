"use server"

import { getPayload, type Payload, type RequiredDataFromCollectionSlug, type Where } from "payload"
import configPromise from "@payload-config"
import { requirePayloadAdmin } from "@/lib/auth/payload-admin"
import { createClient } from "@/lib/supabase/server"
import { createAdminClient } from "@/lib/supabase/admin"
import { addToCart, getCartItems, clearCart as clearPayloadCart } from "@/lib/actions/cart"
import {
  calculateClientDiscount,
  normalizeCategoryDiscounts,
  normalizeDiscountPercent,
  normalizeProductDiscounts,
  type CategoryDiscountRule,
  type ProductDiscountRule,
} from "@/lib/discounts"
import { getRelationshipId } from "@/lib/product-types"
import { revalidatePath } from "next/cache"
import { createSmtpTransport } from "@/lib/email/smtp"
import type { Order, OrderItem, OrderStatus, DeliveryMethod } from "@/types"
import { buildMoyskladStockLossLines, syncOrderToMoysklad } from "@/lib/moysklad/sync"
import { syncOrderToCoffeeskladById } from "@/lib/coffeesklad/sync"
import type { CustomerSessionScope } from "@/lib/auth/constants"
import { calculateTariff } from "@/lib/cdek"
import {
  calculateDeliveryPackaging,
  getDeliveryPackagingSettings,
  shippingLinesFromCartItems,
} from "@/lib/delivery-packaging"

interface OrderEmailItem {
  productName: string
  variantName?: string
  quantity: number
  totalPrice: number
}

interface OrderEmailSummary {
  id: string | number
  orderId?: string | number
  subtotal?: number
  discountAmount?: number
  deliveryCost?: number
  total: number
}

interface PayloadClientRef {
  id?: string | number
  supabaseId?: string | null
  email?: string
  fullName?: string
  phone?: string | null
  createdAt?: string
  updatedAt?: string
}

interface PayloadOrderItem {
  id?: string | number
  productId?: string | number
  productName?: string
  product_name?: string
  variantName?: string
  variant_name?: string
  grindOption?: string | null
  grind_option?: string | null
  quantity?: number | string
  unitPrice?: number | string
  totalPrice?: number | string
  discountPercent?: number | string
  discountAmount?: number | string
  stockProductMoyskladId?: string | null
  stockQuantityKg?: number | string | null
  stockPricePerKg?: number | string | null
}

interface PayloadOrderDoc {
  id: string | number
  orderId?: string
  salesChannel?: "wholesale" | "retail"
  client?: PayloadClientRef | string | number | null
  companyName?: string | null
  companyInn?: string | null
  status?: OrderStatus
  paymentStatus?: string
  deliveryMethod?: DeliveryMethod
  deliveryAddress?: string | null
  subtotal?: number | string
  discountAmount?: number | string
  deliveryCost?: number | string
  total?: number | string
  totalWeightGrams?: number | string
  promoCode?: { id?: string | number } | string | number | null
  comment?: string | null
  adminNotes?: string | null
  cdekTrackingNumber?: string | null
  cap2000TrackingNumber?: string | null
  moyskladCounterpartyId?: string | null
  moyskladCustomerOrderId?: string | null
  moyskladInvoiceOutId?: string | null
  moyskladStockLossId?: string | null
  moyskladStockLossSyncedAt?: string | null
  moyskladStockLossError?: string | null
  moyskladSyncStatus?: string | null
  moyskladSyncError?: string | null
  moyskladSyncedAt?: string | null
  createdAt?: string
  updatedAt?: string
  items?: PayloadOrderItem[]
}

interface PayloadClientDoc {
  id: number
  customerType?: "individual" | "business" | null
  fullName?: string
  email?: string
  phone?: string | null
  address?: string | null
  moyskladCounterpartyId?: string | null
  discountPercent?: number | string
  categoryDiscounts?: {
    category?: { id?: string | number; name?: string } | string | number | null
    discountPercent?: number | string | null
  }[] | null
  productDiscounts?: {
    products?: ({ id?: string | number; name?: string } | string | number)[] | null
    discountPercent?: number | string | null
  }[] | null
}

interface SupabaseCompanyRow {
  id: string
  name: string | null
  inn: string | null
  kpp?: string | null
  ogrn?: string | null
  legal_address?: string | null
  actual_address?: string | null
  contact_phone?: string | null
  contact_email?: string | null
  moysklad_counterparty_id?: string | null
}

const smtpTransporter = createSmtpTransport()

const INVOICE_SELLER = {
  name: 'ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ "ПЕЙДЖ КОФЕ"',
  inn: "2366021670",
  kpp: "236601001",
  address: "354003, Россия, Краснодарский край, г Сочи, ул Пластунская, 79/1, 1",
  bank: "ЮГО-ЗАПАДНЫЙ БАНК ПАО СБЕРБАНК, г Ростов-на-Дону",
  bik: "046015602",
  account: "40702810230060009772",
  corrAccount: "30101810600000000602",
  director: "Тен Игорь Олегович",
}

function formatPrice(n: number) {
  return new Intl.NumberFormat("ru-RU").format(n) + " ₽"
}

function normalizeOrderLineDiscount(value: unknown) {
  const numeric = Number(value) || 0
  return Math.max(0, Math.min(100, Math.round(numeric * 100) / 100))
}

function buildProportionalDiscountLines(cartItems: Awaited<ReturnType<typeof getCartItems>>, discountAmount: number) {
  const subtotal = cartItems.reduce((sum, item) => {
    return sum + (item.variant?.price ?? 0) * item.quantity
  }, 0)

  if (subtotal <= 0 || discountAmount <= 0) return []

  let distributed = 0
  return cartItems
    .map((item, index) => {
      const lineSubtotal = (item.variant?.price ?? 0) * item.quantity
      if (lineSubtotal <= 0) return null

      const lineDiscount = index === cartItems.length - 1
        ? Math.max(0, discountAmount - distributed)
        : Math.round((discountAmount * lineSubtotal) / subtotal)

      distributed += lineDiscount

      return {
        cartItemId: item.id,
        discountPercent: normalizeOrderLineDiscount((lineDiscount / lineSubtotal) * 100),
        discountAmount: lineDiscount,
      }
    })
    .filter((line): line is { cartItemId: string; discountPercent: number; discountAmount: number } => Boolean(line))
}

async function sendOrderEmail(email: string, order: OrderEmailSummary, items: OrderEmailItem[], pdfBuffer?: Uint8Array) {
  const itemsHtml = items.map(i =>
    `<tr><td style="padding:8px;border-bottom:1px solid #eee">${i.productName} ${i.variantName ? `(${i.variantName})` : ""}</td><td style="padding:8px;border-bottom:1px solid #eee;text-align:center">${i.quantity}</td><td style="padding:8px;border-bottom:1px solid #eee;text-align:right">${formatPrice(i.totalPrice)}</td></tr>`
  ).join("")
  const summaryHtml = [
    order.subtotal ? `<p style="margin:0 0 6px;color:#666">Товары: <strong>${formatPrice(order.subtotal)}</strong></p>` : "",
    order.discountAmount && order.discountAmount > 0 ? `<p style="margin:0 0 6px;color:#16a34a">Скидка: <strong>−${formatPrice(order.discountAmount)}</strong></p>` : "",
    order.deliveryCost && order.deliveryCost > 0 ? `<p style="margin:0 0 6px;color:#666">Доставка: <strong>${formatPrice(order.deliveryCost)}</strong></p>` : "",
  ].filter(Boolean).join("")

  const attachments = pdfBuffer
    ? [{
      filename: `Счёт_${order.orderId || order.id}.pdf`,
      content: Buffer.from(pdfBuffer),
      contentType: "application/pdf",
    }]
    : []

  await smtpTransporter.sendMail({
    from: `"10coffee" <${process.env.SMTP_EMAIL}>`,
    to: email,
    subject: `Заказ ${order.orderId || order.id} оформлен — 10coffee`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:32px">
        <h2 style="margin:0 0 16px">Спасибо за заказ!</h2>
        <p style="color:#666;margin:0 0 24px">Ваш заказ <strong>${order.orderId || order.id}</strong> принят и ожидает обработки.</p>
        <table style="width:100%;border-collapse:collapse;margin:0 0 24px">
          <thead><tr style="background:#f5f5f5"><th style="padding:8px;text-align:left">Товар</th><th style="padding:8px;text-align:center">Кол-во</th><th style="padding:8px;text-align:right">Сумма</th></tr></thead>
          <tbody>${itemsHtml}</tbody>
        </table>
        <div style="background:#f5f5f5;border-radius:12px;padding:16px;margin:0 0 24px">
          ${summaryHtml}
          <p style="margin:0;font-size:18px;font-weight:bold">Итого: ${formatPrice(order.total)}</p>
        </div>
        <p style="color:#999;font-size:12px;margin:0">Менеджер свяжется с вами для подтверждения заказа.</p>
      </div>
    `,
    attachments,
  })
}

async function sendStatusEmail(email: string, orderId: string, status: string, statusLabel: string) {
  await smtpTransporter.sendMail({
    from: `"10coffee" <${process.env.SMTP_EMAIL}>`,
    to: email,
    subject: `Заказ ${orderId} — ${statusLabel}`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">
        <h2 style="margin:0 0 16px">Обновление заказа</h2>
        <p style="color:#666;margin:0 0 24px">Статус вашего заказа <strong>${orderId}</strong> изменён:</p>
        <div style="background:#f5f5f5;border-radius:12px;padding:20px;margin:0 0 24px">
          <p style="margin:0;font-size:18px;font-weight:bold">${statusLabel}</p>
        </div>
        <p style="color:#999;font-size:12px;margin:0">Подробности в личном кабинете.</p>
      </div>
    `,
  })
}

async function getPayloadClient() {
  return getPayload({ config: configPromise })
}

async function incrementPromoUses(payload: Payload, promoCodeId: string | number) {
  // Compare-and-swap prevents lost increments while keeping the write inside
  // Payload, so collection hooks and validation are never bypassed.
  for (let attempt = 0; attempt < 5; attempt++) {
    const promo = await payload.findByID({
      collection: "promo-codes",
      id: promoCodeId,
      depth: 0,
    })
    const currentUses = Number(promo.currentUses) || 0
    const result = await payload.update({
      collection: "promo-codes",
      where: {
        and: [
          { id: { equals: promoCodeId } },
          { currentUses: { equals: currentUses } },
        ],
      },
      data: { currentUses: currentUses + 1 },
      depth: 0,
    })
    if (result.docs.length > 0) return
  }

  throw new Error(`Не удалось атомарно обновить счётчик промокода ${promoCodeId}`)
}

async function getCurrentUserId(sessionScope?: CustomerSessionScope): Promise<string | null> {
  try {
    const supabase = await createClient(sessionScope)
    const { data: { user } } = await supabase.auth.getUser()
    return user?.id ?? null
  } catch {
    return null
  }
}

async function getClientDoc(supabaseUserId: string): Promise<{
  id: number
  fullName?: string
  email?: string
  phone?: string | null
  moyskladCounterpartyId?: string | null
  discountPercent: number
  categoryDiscounts: CategoryDiscountRule[]
  productDiscounts: ProductDiscountRule[]
} | null> {
  try {
    const payload = await getPayloadClient()
    const { docs } = await payload.find({
      collection: "clients",
      where: { supabaseId: { equals: supabaseUserId } },
      limit: 1,
      depth: 1,
    })
    if (!docs[0]) return null
    const client = docs[0] as PayloadClientDoc
    const categoryDiscounts = (client.categoryDiscounts || [])
      .map((rule): CategoryDiscountRule | null => {
        const categoryId = getRelationshipId(rule.category)
        if (categoryId === null) return null

        const categoryName = typeof rule.category === "object" && rule.category !== null
          ? rule.category.name
          : undefined

        return {
          categoryId: String(categoryId),
          categoryName,
          discountPercent: normalizeDiscountPercent(rule.discountPercent),
        }
      })
      .filter((rule): rule is CategoryDiscountRule => rule !== null)
    const productDiscounts = (client.productDiscounts || []).flatMap((rule) => {
      const discountPercent = normalizeDiscountPercent(rule.discountPercent)
      return (rule.products || [])
        .map((product): ProductDiscountRule | null => {
          const productId = getRelationshipId(product)
          if (productId === null) return null
          return {
            productId: String(productId),
            productName: typeof product === "object" && product !== null ? product.name : undefined,
            discountPercent,
          }
        })
        .filter((entry): entry is ProductDiscountRule => entry !== null)
    })

    return {
      id: client.id,
      fullName: client.fullName,
      email: client.email,
      phone: client.phone,
      moyskladCounterpartyId: client.moyskladCounterpartyId,
      discountPercent: normalizeDiscountPercent(client.discountPercent),
      categoryDiscounts: normalizeCategoryDiscounts(categoryDiscounts),
      productDiscounts: normalizeProductDiscounts(productDiscounts),
    }
  } catch {
    return null
  }
}

async function getClientDocId(supabaseUserId: string): Promise<number | null> {
  const doc = await getClientDoc(supabaseUserId)
  return doc?.id ?? null
}

// ============================================================
// Transform: Payload doc → frontend Order type
// ============================================================

function transformOrderItem(item: PayloadOrderItem): OrderItem {
  return {
    id: String(item.id ?? ""),
    order_id: "",
    product_id: String(item.productId ?? ""),
    variant_id: "",
    product_name: item.productName || "",
    variant_name: item.variantName || "",
    grind_option: item.grindOption || null,
    quantity: Number(item.quantity) || 0,
    unit_price: Number(item.unitPrice) || 0,
    total_price: Number(item.totalPrice) || 0,
    discount_percent: Number(item.discountPercent) || 0,
    discount_amount: Number(item.discountAmount) || 0,
    weight_grams: null,
    stock_product_moysklad_id: item.stockProductMoyskladId || null,
    stock_quantity_kg: Number(item.stockQuantityKg) || null,
    stock_price_per_kg: Number(item.stockPricePerKg) || null,
  }
}

function transformOrder(doc: PayloadOrderDoc): Order {
  const clientRef = doc.client
  const clientId = typeof clientRef === "object" && clientRef !== null ? String(clientRef?.id) : String(clientRef ?? "")

  return {
    id: String(doc.id),
    order_id: doc.orderId || "",
    client_id: clientId,
    company_name: doc.companyName || null,
    company_inn: doc.companyInn || null,
    status: doc.status as OrderStatus,
    payment_status: doc.paymentStatus || "pending",
    delivery_method: doc.deliveryMethod as DeliveryMethod,
    delivery_address: doc.deliveryAddress || null,
    subtotal: Number(doc.subtotal) || 0,
    discount_amount: Number(doc.discountAmount) || 0,
    delivery_cost: Number(doc.deliveryCost) || 0,
    total: Number(doc.total) || 0,
    total_weight_grams: Number(doc.totalWeightGrams) || 0,
    promo_code_id: doc.promoCode ? String(typeof doc.promoCode === "object" && doc.promoCode !== null ? doc.promoCode.id : doc.promoCode) : null,
    comment: doc.comment || null,
    admin_notes: doc.adminNotes || null,
    cdek_tracking_number: doc.cdekTrackingNumber || null,
    cap_2000_tracking_number: doc.cap2000TrackingNumber || null,
    moysklad_counterparty_id: doc.moyskladCounterpartyId || null,
    moysklad_customer_order_id: doc.moyskladCustomerOrderId || null,
    moysklad_invoice_out_id: doc.moyskladInvoiceOutId || null,
    moysklad_stock_loss_id: doc.moyskladStockLossId || null,
    moysklad_stock_loss_synced_at: doc.moyskladStockLossSyncedAt || null,
    moysklad_stock_loss_error: doc.moyskladStockLossError || null,
    moysklad_sync_status: doc.moyskladSyncStatus || null,
    moysklad_sync_error: doc.moyskladSyncError || null,
    moysklad_synced_at: doc.moyskladSyncedAt || null,
    created_at: doc.createdAt || "",
    updated_at: doc.updatedAt || "",
    items: (doc.items || []).map(transformOrderItem),
    client: typeof clientRef === "object" && clientRef ? {
      id: String(clientRef.id),
      email: clientRef.email || "",
      full_name: clientRef.fullName || "",
      phone: clientRef.phone || null,
      created_at: clientRef.createdAt || "",
      updated_at: clientRef.updatedAt || "",
    } : undefined,
  }
}

// ============================================================
// Client-facing actions
// ============================================================

export async function getClientOrders(sessionScope: CustomerSessionScope = "business"): Promise<Order[]> {

  const userId = await getCurrentUserId(sessionScope)
  if (!userId) return []

  const clientDoc = await getClientDoc(userId)
  if (!clientDoc) return []
  const payload = await getPayloadClient()
  // Contact details are editable and do not prove order ownership.
  const ownerWhere: Where = { client: { equals: clientDoc.id } }

  const where: Where = {
    and: [
      ownerWhere,
      sessionScope === "individual" ? {
        salesChannel: { equals: "retail" },
      } : {
        or: [
          { salesChannel: { equals: "wholesale" } },
          { paymentStatus: { in: ["paid", "refunded"] } },
        ],
      },
    ],
  }

  const { docs } = await payload.find({
    collection: "orders",
    where,
    sort: "-createdAt",
    depth: 1,
    limit: 200,
  })

  return (docs as PayloadOrderDoc[]).map(transformOrder)
}

export async function getOrderById(orderId: string): Promise<Order | null> {
  const userId = await getCurrentUserId()
  if (!userId) return null
  const clientId = await getClientDocId(userId)
  if (!clientId) return null
  const payload = await getPayloadClient()

  try {
    const { docs } = await payload.find({
      collection: "orders",
      where: { and: [{ id: { equals: orderId } }, { client: { equals: clientId } }] },
      limit: 1,
      depth: 1,
    })
    if (!docs[0]) return null
    const order = docs[0] as PayloadOrderDoc
    return transformOrder(order)
  } catch {
    return null
  }
}

export async function createOrder(params: {
  companyId?: string
  deliveryMethod: DeliveryMethod
  deliveryAddress?: string
  comment?: string
  promoCodeId?: string
  discountAmount?: number
  deliveryCost?: number
  cdekCityCode?: number
  cdekDeliveryType?: "pickup" | "courier"
}): Promise<{ error?: string; success?: boolean; orderId?: string; moyskladInvoiceCreated?: boolean }> {

  const supabase = await createClient("business")
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: "Не авторизован" }

  const clientDoc = await getClientDoc(user.id)
  if (!clientDoc) return { error: "Клиент не найден" }
  const clientDocId = clientDoc.id
  const adminDb = createAdminClient()

  const cartItems = await getCartItems("business")
  if (!cartItems || cartItems.length === 0) return { error: "Корзина пуста" }

  // Calculate totals
  const subtotal = cartItems.reduce((sum, item) => {
    return sum + (item.variant?.price ?? 0) * item.quantity
  }, 0)

  const totalWeight = cartItems.reduce((sum, item) => {
    return sum + (item.variant?.weight_grams ?? 0) * item.quantity
  }, 0)

  // Recalculate the promo on the server. Never trust the amount sent by the browser.
  let payloadPromoId: number | undefined
  let promoDiscountAmount = 0
  let promoDiscountLines: { cartItemId: string; discountPercent: number; discountAmount: number }[] = []

  if (params.promoCodeId) {
    const payloadClient = await getPayloadClient()
    const { docs } = await payloadClient.find({
      collection: "promo-codes",
      where: { id: { equals: params.promoCodeId } },
      limit: 1,
      depth: 0,
    })
    const promo = docs[0]
    if (!promo) return { error: "Промокод не найден" }
    if (!promo.isActive) return { error: "Промокод неактивен" }
    if (promo.startsAt && new Date(promo.startsAt as string) > new Date()) return { error: "Промокод ещё не активен" }
    if (promo.expiresAt && new Date(promo.expiresAt as string) < new Date()) return { error: "Промокод истёк" }
    if (promo.maxUses != null && Number(promo.currentUses || 0) >= Number(promo.maxUses)) return { error: "Промокод исчерпан" }
    if (promo.restrictedToEmail && String(promo.restrictedToEmail).toLowerCase() !== String(user.email || "").toLowerCase()) {
      return { error: "Промокод недоступен для вашего аккаунта" }
    }
    if (promo.minOrderAmount && subtotal < Number(promo.minOrderAmount)) {
      return { error: `Минимальная сумма заказа: ${Number(promo.minOrderAmount).toLocaleString("ru-RU")} ₽` }
    }

    if (promo.isSingleUse) {
      const { data: usages } = await adminDb
        .from("promo_code_usages")
        .select("id")
        .eq("promo_code_id", String(promo.id))
        .eq("client_id", user.id)
        .limit(1)
      if (usages?.length) return { error: "Вы уже использовали этот промокод" }
    }

    const applicableProductIds = new Set(
      (Array.isArray(promo.applicableProducts) ? promo.applicableProducts : [])
        .map((value) => getRelationshipId(value))
        .filter((value): value is string | number => value !== null)
        .map(String)
    )
    const eligibleCartItems = applicableProductIds.size > 0
      ? cartItems.filter((item) => applicableProductIds.has(String(item.product_id)))
      : cartItems
    const eligibleSubtotal = eligibleCartItems.reduce((sum, item) => {
      return sum + (item.variant?.price ?? 0) * item.quantity
    }, 0)
    if (applicableProductIds.size > 0 && eligibleSubtotal <= 0) {
      return { error: "В корзине нет товаров, участвующих в промокоде" }
    }

    const discountValue = Number(promo.discountValue) || 0
    promoDiscountAmount = promo.discountType === "fixed_amount"
      ? Math.min(discountValue, eligibleSubtotal)
      : Math.round((eligibleSubtotal * discountValue) / 100)
    promoDiscountLines = buildProportionalDiscountLines(eligibleCartItems, promoDiscountAmount)
    payloadPromoId = promo.id
  }

  // Apply the greater of the personal discount and the validated promo.
  const clientDiscountResult = calculateClientDiscount(cartItems, {
    discountPercent: clientDoc.discountPercent,
    categoryDiscounts: clientDoc.categoryDiscounts,
    productDiscounts: clientDoc.productDiscounts,
  })
  const clientDiscountAmount = clientDiscountResult.amount
  const discountAmount = Math.max(clientDiscountAmount, promoDiscountAmount)
  const promoWins = Boolean(payloadPromoId) && promoDiscountAmount > 0 && promoDiscountAmount >= clientDiscountAmount
  const discountLines = promoWins
    ? promoDiscountLines
    : clientDiscountResult.lines.map((line) => ({
        cartItemId: line.cartItemId,
        discountPercent: normalizeOrderLineDiscount(line.discountPercent),
        discountAmount: line.discountAmount,
      }))
  const appliedDiscountPercent = !promoWins && discountAmount === clientDiscountAmount &&
    clientDiscountResult.hasBaseDiscount &&
    !clientDiscountResult.hasCategoryDiscount &&
    !clientDiscountResult.hasProductDiscount
    ? clientDoc.discountPercent
    : 0

  let deliveryCost = params.deliveryCost ?? 0
  if (params.deliveryMethod === "cdek") {
    const cityCode = Number(params.cdekCityCode)
    if (!Number.isInteger(cityCode) || cityCode <= 0 || !params.cdekDeliveryType) {
      return { error: "Выберите город и способ доставки СДЭК" }
    }
    try {
      const packagingSettings = await getDeliveryPackagingSettings()
      const packaging = calculateDeliveryPackaging(shippingLinesFromCartItems(cartItems), packagingSettings)
      const tariffs = await calculateTariff(
        cityCode,
        packaging.packages.map(({ weight, length, width, height }) => ({ weight, length, width, height })),
      )
      const allowedModes = params.cdekDeliveryType === "courier" ? [1, 3] : [2, 4]
      const tariff = tariffs
        .filter((item) => allowedModes.includes(item.delivery_mode))
        .sort((left, right) => left.delivery_sum - right.delivery_sum)[0]
      if (!tariff) return { error: "Для выбранного способа доставки нет тарифа СДЭК" }
      deliveryCost = Math.round(tariff.delivery_sum + packaging.packagingCost)
    } catch (error) {
      console.error("[orders] Не удалось проверить тариф СДЭК", error)
      return { error: "Не удалось подтвердить стоимость доставки СДЭК. Попробуйте ещё раз." }
    }
  }
  const total = Math.max(0, subtotal - discountAmount) + deliveryCost

  // Resolve company name/inn from Supabase companies table
  let companyName: string | undefined
  let companyInn: string | undefined
  let companyKpp: string | undefined
  let companyAddress: string | undefined
  let companyForMoysklad: {
    id?: string
    name?: string
    inn?: string
    kpp?: string | null
    ogrn?: string | null
    legalAddress?: string | null
    actualAddress?: string | null
    contactPhone?: string | null
    contactEmail?: string | null
    moyskladCounterpartyId?: string | null
  } | null = null
  const companyId = params.companyId?.trim()

  if (companyId) {
    const { data: company } = await adminDb
      .from("companies")
      .select("id, name, inn, kpp, ogrn, legal_address, actual_address, contact_phone, contact_email, moysklad_counterparty_id")
      .eq("id", companyId)
      .eq("client_id", user.id)
      .maybeSingle<SupabaseCompanyRow>()

    if (company) {
      companyName = company.name || undefined
      companyInn = company.inn || undefined
      companyKpp = company.kpp || undefined
      companyAddress = company.legal_address || company.actual_address || undefined
      companyForMoysklad = {
        id: company.id,
        name: companyName,
        inn: companyInn,
        kpp: companyKpp || null,
        ogrn: company.ogrn || null,
        legalAddress: company.legal_address || null,
        actualAddress: company.actual_address || null,
        contactPhone: company.contact_phone || null,
        contactEmail: company.contact_email || null,
        moyskladCounterpartyId: company.moysklad_counterparty_id || null,
      }
    }
  } else {
    const { data: companies } = await adminDb
      .from("companies")
      .select("id, name, inn, kpp, ogrn, legal_address, actual_address, contact_phone, contact_email, moysklad_counterparty_id")
      .eq("client_id", user.id)
      .order("created_at", { ascending: false })
      .limit(2)
      .returns<SupabaseCompanyRow[]>()

    if (companies?.length === 1) {
      companyName = companies[0].name || undefined
      companyInn = companies[0].inn || undefined
      companyKpp = companies[0].kpp || undefined
      companyAddress = companies[0].legal_address || companies[0].actual_address || undefined
      companyForMoysklad = {
        id: companies[0].id,
        name: companyName,
        inn: companyInn,
        kpp: companyKpp || null,
        ogrn: companies[0].ogrn || null,
        legalAddress: companies[0].legal_address || null,
        actualAddress: companies[0].actual_address || null,
        contactPhone: companies[0].contact_phone || null,
        contactEmail: companies[0].contact_email || null,
        moyskladCounterpartyId: companies[0].moysklad_counterparty_id || null,
      }
    }
  }

  if (!companyName || !companyInn) {
    return { error: "Выберите компанию для оформления заказа" }
  }

  // Build items array for Payload
  const discountPercentByItem = new Map(discountLines.map((line) => [line.cartItemId, line.discountPercent]))
  const discountAmountByItem = new Map(discountLines.map((line) => [line.cartItemId, line.discountAmount]))
  const items = cartItems.map((item) => {
    const stockLossLine = buildMoyskladStockLossLines([item])[0]
    const lineSubtotal = (item.variant?.price ?? 0) * item.quantity
    const lineDiscountPercent = discountPercentByItem.get(item.id) || 0
    const lineDiscountAmount = discountAmountByItem.get(item.id) || 0

    return {
      productId: item.product?.id || "",
      productName: item.product?.name || "",
      variantName: item.variant?.name || "",
      grindOption: item.grind_option || "",
      quantity: item.quantity,
      unitPrice: item.variant?.price ?? 0,
      totalPrice: lineSubtotal,
      discountPercent: lineDiscountPercent,
      discountAmount: lineDiscountAmount,
      stockProductMoyskladId: stockLossLine?.productMoyskladId || "",
      stockQuantityKg: stockLossLine?.quantityKg || 0,
      stockPricePerKg: stockLossLine?.pricePerKg || 0,
    }
  })

  // Create order via Payload API
  const payload = await getPayloadClient()
  const orderData: RequiredDataFromCollectionSlug<"orders"> = {
    client: clientDocId,
    salesChannel: "wholesale",
    customerType: "business",
    checkoutMode: "account",
    paymentMethod: "invoice",
    paymentStatus: "pending",
    status: "new",
    customerFullName: clientDoc.fullName || "",
    customerEmail: clientDoc.email || user.email || "",
    customerPhone: clientDoc.phone || "",
    deliveryMethod: params.deliveryMethod,
    deliveryAddress: params.deliveryAddress || "",
    subtotal,
    discountAmount,
    deliveryCost,
    total,
    totalWeightGrams: totalWeight,
    comment: params.comment || "",
    items,
  }

  if (appliedDiscountPercent > 0) orderData.discountPercent = appliedDiscountPercent
  if (companyName) orderData.companyName = companyName
  if (companyInn) orderData.companyInn = companyInn
  if (promoWins && payloadPromoId) orderData.promoCode = payloadPromoId

  const doc = await payload.create({
    collection: "orders",
    data: orderData,
  }) as PayloadOrderDoc

  // Also populate order_items Supabase table (reliable source for repeat orders)
  const orderItemsRows = cartItems.map((item) => {
    const lineSubtotal = (item.variant?.price ?? 0) * item.quantity
    const lineDiscountPercent = discountPercentByItem.get(item.id) || 0
    return {
      order_id: String(doc.id),
      product_id: item.product_id,
      variant_id: item.variant_id,
      product_name: item.product?.name || "",
      variant_name: item.variant?.name || "",
      grind_option: item.grind_option || null,
      quantity: item.quantity,
      unit_price: item.variant?.price ?? 0,
      total_price: lineSubtotal,
      discount_percent: lineDiscountPercent,
      discount_amount: discountAmountByItem.get(item.id) || 0,
      weight_grams: item.variant?.weight_grams ?? null,
    }
  })

  await adminDb.from("order_items").insert(orderItemsRows)

  const moyskladSyncResult = await syncOrderToMoysklad({
    payload,
    order: {
      id: doc.id,
      orderId: doc.orderId,
      salesChannel: "wholesale",
      customerType: "business",
      createdAt: doc.createdAt,
      subtotal,
      discountAmount,
      deliveryCost,
      total,
      deliveryMethod: params.deliveryMethod,
      deliveryAddress: params.deliveryAddress || "",
      comment: params.comment || "",
    },
    client: {
      id: clientDocId,
      fullName: clientDoc.fullName,
      email: clientDoc.email || user.email || "",
      phone: clientDoc.phone || null,
      moyskladCounterpartyId: clientDoc.moyskladCounterpartyId || null,
    },
    company: companyForMoysklad,
    cartItems,
    discountLines,
  })
  const hasMoyskladInvoice = "moyskladInvoiceOutId" in moyskladSyncResult && Boolean(moyskladSyncResult.moyskladInvoiceOutId)

  // Clear cart (now uses direct Supabase queries, no Payload transaction issues)
  await clearPayloadCart("business")

  // Send order confirmation email with invoice PDF
  try {
    const { generateInvoicePDF } = await import("@/lib/generate-invoice")
    const invoiceDate = new Date(doc.createdAt || Date.now()).toLocaleDateString("ru-RU", {
      day: "numeric",
      month: "long",
      year: "numeric",
    })
    const invoiceItems = items.map((item) => ({
      name: `${item.productName}${item.variantName ? ` (${item.variantName})` : ""}${item.grindOption ? `, ${item.grindOption}` : ""}`,
      quantity: item.quantity,
      unit: "шт",
      price: item.unitPrice,
      vat: "",
      total: item.totalPrice,
    }))
    const orderForInvoice = {
      id: doc.id,
      orderId: doc.orderId,
      invoiceNumber: doc.orderId || String(doc.id),
      invoiceDate,
      sellerName: INVOICE_SELLER.name,
      sellerInn: INVOICE_SELLER.inn,
      sellerKpp: INVOICE_SELLER.kpp,
      sellerAddress: INVOICE_SELLER.address,
      sellerBank: INVOICE_SELLER.bank,
      sellerBik: INVOICE_SELLER.bik,
      sellerAccount: INVOICE_SELLER.account,
      sellerCorrAccount: INVOICE_SELLER.corrAccount,
      sellerDirector: INVOICE_SELLER.director,
      buyerName: companyName || "—",
      buyerInn: companyInn || "—",
      buyerKpp: companyKpp || "—",
      buyerAddress: companyAddress || params.deliveryAddress || "—",
      items: invoiceItems,
      subtotal,
      discountAmount,
      deliveryCost,
      vatLabel: "",
      vatAmount: 0,
      total,
      companyName,
      companyInn,
    }
    let pdfBuffer: Uint8Array | undefined
    if (!hasMoyskladInvoice) {
      try {
        pdfBuffer = await generateInvoicePDF(orderForInvoice)
      } catch (pdfErr) {
        console.error("Failed to generate invoice PDF:", pdfErr)
      }
    }
    await sendOrderEmail(user.email!, orderForInvoice, items, pdfBuffer)
  } catch (emailErr) {
    console.error("Failed to send order email:", emailErr)
  }

  // Create notification via admin client (RLS requires admin for INSERT)
  await adminDb.from("notifications").insert({
    client_id: user.id,
    type: "order_update",
    title: "Заказ создан",
    message: `Ваш заказ ${doc.orderId || doc.id} ожидает обработки`,
    data: { order_id: String(doc.id) },
  })

  // Track promo code usage via Supabase
  if (promoWins && payloadPromoId) {
    await supabase.from("promo_code_usages").insert({
      promo_code_id: String(payloadPromoId),
      client_id: user.id,
      order_id: String(doc.id),
    })
    await incrementPromoUses(payload, payloadPromoId)
  }

  revalidatePath("/dashboard")

  // Выгрузка в КофеСклад (основная учётная система). Идёт независимо от
  // результата МойСклад и никогда не отменяет оформление заказа.
  await syncOrderToCoffeeskladById(payload, doc.id)

  return { success: true, orderId: String(doc.id), moyskladInvoiceCreated: hasMoyskladInvoice }
}

export async function repeatOrder(
  orderId: string,
  sessionScope: CustomerSessionScope = "business",
): Promise<{ success?: boolean; error?: string; skippedCount?: number }> {
  const userId = await getCurrentUserId(sessionScope)
  if (!userId) return { error: "Не авторизован" }

  const payload = await getPayloadClient()

  try {
    const order = await payload.findByID({
      collection: "orders",
      id: orderId,
      depth: 1,
    }) as PayloadOrderDoc

    let ownerId = typeof order.client === "object" && order.client !== null
      ? order.client.supabaseId
      : null
    if (!ownerId && order.client != null) {
      const client = await payload.findByID({
        collection: "clients",
        id: typeof order.client === "object" ? order.client.id! : order.client,
        depth: 0,
      }) as PayloadClientRef
      ownerId = client.supabaseId
    }
    if (ownerId !== userId) return { error: "Заказ не найден" }

    const items = (order.items || []).map((item) => ({
      productId: item.productId,
      productName: item.productName || item.product_name || "",
      variantName: item.variantName || item.variant_name || "",
      grindOption: item.grindOption || item.grind_option || "",
      quantity: Number(item.quantity ?? 1),
    }))
    if (items.length === 0) return { error: "В заказе нет позиций" }

    let addedCount = 0
    for (const item of items) {
      // Prefer the saved product ID: names may change after the original order.
      // Only legacy orders without an ID are resolved by their catalog name.
      const result = await payload.find({
        collection: "products",
        where: item.productId
          ? { id: { equals: item.productId } }
          : { name: { equals: item.productName } },
        limit: 2,
        depth: 0,
      })
      if (result.docs.length !== 1) continue
      const product = result.docs[0]
      if (product.isVisible === false) continue

      const variants = (product.variants || []).filter(
        (candidate) => candidate.name === item.variantName
      )
      const variant = variants.length === 1 ? variants[0] : null
      if (!variant?.id || variant.isAvailable === false) continue
      if (!Number.isInteger(item.quantity) || item.quantity <= 0) continue

      const cartResult = await addToCart({
        productId: String(product.id),
        variantId: String(variant.id),
        quantity: item.quantity,
        grindOption: item.grindOption,
      }, sessionScope)
      if (cartResult.success) addedCount++
    }

    if (addedCount === 0) return { error: "Товары из заказа не найдены в каталоге" }

    revalidatePath(sessionScope === "individual" ? "/main" : "/dashboard")
    return { success: true, skippedCount: items.length - addedCount }
  } catch {
    return { error: "Заказ не найден" }
  }
}
export async function deleteOrder(orderId: string): Promise<{ success?: boolean; error?: string }> {
  const userId = await getCurrentUserId()
  if (!userId) return { error: "Не авторизован" }

  const clientDocId = await getClientDocId(userId)
  if (!clientDocId) return { error: "Клиент не найден" }

  const payload = await getPayloadClient()

  try {
    const doc = await payload.findByID({
      collection: "orders",
      id: orderId,
      depth: 0,
    }) as PayloadOrderDoc

    const docClient = typeof doc.client === "object" && doc.client !== null
      ? doc.client?.id
      : doc.client
    if (String(docClient) !== String(clientDocId)) {
      return { error: "Нет доступа" }
    }

    // Keep financial records and hooks intact. Customers may only cancel a
    // new unpaid order; deletion belongs to the administrative API.
    if (doc.status !== "new" || !["pending", "unpaid"].includes(doc.paymentStatus || "pending")) {
      return { error: "Можно отменить только новый неоплаченный заказ" }
    }
    const cancelled = await payload.update({
      collection: "orders",
      where: { and: [
        { id: { equals: orderId } },
        { client: { equals: clientDocId } },
        { status: { equals: "new" } },
        { paymentStatus: { equals: doc.paymentStatus || "pending" } },
      ] },
      data: { status: "cancelled" },
    })
    if (!cancelled.docs.length) return { error: "Статус заказа изменился. Обновите страницу" }

    revalidatePath("/dashboard/orders")
    return { success: true }
  } catch {
    return { error: "Заказ не найден" }
  }
}

// ============================================================
// Admin actions
// ============================================================

export async function getAllOrders(): Promise<Order[]> {
  const { payload, user } = await requirePayloadAdmin("readOrders")

  const { docs } = await payload.find({
    collection: "orders",
    overrideAccess: false,
    user,
    sort: "-createdAt",
    depth: 1,
    limit: 500,
  })

  return (docs as PayloadOrderDoc[]).map(transformOrder)
}

export async function updateOrderStatus(
  orderId: string,
  newStatus: OrderStatus,
  note?: string
): Promise<{ success?: boolean; error?: string }> {
  const { payload, user } = await requirePayloadAdmin("manageOrders")

  // Get current order
  const doc = await payload.findByID({
    collection: "orders",
    overrideAccess: false,
    user,
    id: orderId,
    depth: 1,
  }) as PayloadOrderDoc

  const oldStatus = doc.status

  // Update via Payload
  await payload.update({
    collection: "orders",
    overrideAccess: false,
    user,
    id: orderId,
    data: { status: newStatus },
  })

  // Log status change via Supabase
  const supabase = await createClient()
  await supabase.from("order_status_history").insert({
    order_id: orderId,
    old_status: oldStatus,
    new_status: newStatus,
    // Legacy history references auth.users UUIDs, not Payload admin IDs.
    changed_by: null,
    note: [`Payload admin ${user.id}`, note].filter(Boolean).join(": "),
  })

  // Notify client
  const statusLabels: Record<string, string> = {
    new: "новый",
    confirmed: "подтверждён",
    invoiced: "счёт выставлен",
    paid: "оплачен",
    in_production: "в производстве",
    ready: "собран",
    shipped: "отгружен",
    delivered: "доставлен",
    returned: "возврат",
    cancelled: "отменён",
  }

  const clientRef = doc.client
  const supabaseId = typeof clientRef === "object" && clientRef !== null ? clientRef?.supabaseId : null

  if (supabaseId) {
    const adminDb = createAdminClient()
    await adminDb.from("notifications").insert({
      client_id: supabaseId,
      type: "order_update",
      title: "Обновление заказа",
      message: `Статус вашего заказа изменён: ${statusLabels[newStatus] || newStatus}`,
      data: { order_id: orderId },
    })

    // Send email notification about status change
    try {
      const { data: userData } = await adminDb.auth.admin.getUserById(supabaseId)
      if (userData?.user?.email) {
        const orderDisplayId = doc.orderId || orderId
        await sendStatusEmail(
          userData.user.email,
          orderDisplayId,
          newStatus,
          statusLabels[newStatus] || newStatus
        )
      }
    } catch (emailErr) {
      console.error("Failed to send status email:", emailErr)
    }
  }

  revalidatePath("/admin/orders")
  return { success: true }
}

export async function sendPromoCodeEmail(email: string, code: string, discount: string, description?: string) {
  await requirePayloadAdmin("manageOrders")
  try {
    await smtpTransporter.sendMail({
      from: `"10coffee" <${process.env.SMTP_EMAIL}>`,
      to: email,
      subject: `Промокод от 10coffee — скидка ${discount}`,
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">
          <h2 style="margin:0 0 16px">У вас промокод!</h2>
          <p style="color:#666;margin:0 0 24px">${description || "Используйте промокод при оформлении заказа в личном кабинете."}</p>
          <div style="background:#f5f5f5;border-radius:12px;padding:20px;text-align:center;margin:0 0 24px">
            <p style="margin:0 0 8px;color:#999;font-size:13px">Ваш промокод</p>
            <p style="margin:0;font-weight:bold;font-size:28px;letter-spacing:3px;color:#5b328a">${code}</p>
            <p style="margin:8px 0 0;font-size:14px;font-weight:bold">Скидка ${discount}</p>
          </div>
          <p style="color:#999;font-size:12px;margin:0">Введите промокод при оформлении заказа на сайте.</p>
        </div>
      `,
    })
    return { success: true }
  } catch (err) {
    console.error("Failed to send promo email:", err)
    return { error: "Не удалось отправить письмо" }
  }
}
