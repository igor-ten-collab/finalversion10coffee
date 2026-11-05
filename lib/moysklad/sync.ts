import type { Payload } from "payload"
import { dbQuery } from "@/lib/db"
import { getMoyskladConfig, assertMoyskladReady } from "./config"
import type { MoyskladConfig, MoyskladSalesChannel as SalesChannel } from "./config"
import { hasMoyskladErrorCode, MoyskladApiError, extractMoyskladId, moyskladGetList, moyskladMeta, moyskladRequest } from "./client"
import { writeMoyskladLog } from "./logs"
import { computeOrderContentHash } from "./order-hash"
import { canExportOrderToMoysklad } from "./order-eligibility"
import { orderExternalCode, assertRemoteOrderIdentity, assertRemoteInvoiceIdentity, assertRemoteOrderTotalsConsistent } from "./order-identity"
import { assertMoyskladDocumentTotal, reconcileMoyskladOrderTotals, type MoyskladDiscountLine } from "./order-totals"
import { DELIVERY_METHOD_LABELS } from "@/lib/utils/constants"
import { ensureMoyskladBundleForVariant } from "./bundles"
import type {
  MoyskladCounterparty,
  MoyskladCustomerOrder,
  MoyskladInvoiceOut,
  MoyskladLoss,
  MoyskladOrderPositionPayload,
  MoyskladSalesChannel,
} from "./types"
import type { CartItem, DeliveryMethod } from "@/types"

interface SyncClient {
  id?: string | number
  fullName?: string
  email?: string
  phone?: string | null
  moyskladCounterpartyId?: string | null
}

interface SyncCompany {
  id?: string
  name?: string
  inn?: string
  kpp?: string | null
  ogrn?: string | null
  legalAddress?: string | null
  actualAddress?: string | null
  contactEmail?: string | null
  contactPhone?: string | null
  moyskladCounterpartyId?: string | null
}

interface SyncOrder {
  id: string | number
  orderId?: string
  salesChannel?: SalesChannel
  customerType?: "individual" | "business"
  paymentStatus?: string | null
  createdAt?: string
  subtotal?: number
  discountAmount?: number
  deliveryCost?: number
  total?: number
  deliveryMethod?: DeliveryMethod
  deliveryAddress?: string | null
  comment?: string | null
  moyskladCustomerOrderId?: string | null
  moyskladInvoiceOutId?: string | null
}

interface SyncOrderParams {
  payload: Payload
  order: SyncOrder
  client: SyncClient
  company?: SyncCompany | null
  cartItems: CartItem[]
  discountLines?: MoyskladDiscountLine[]
  force?: boolean
}

interface MoyskladProductUomResponse {
  uom?: {
    name?: string
  }
  productFolder?: {
    meta?: {
      href?: string
    }
  }
}

interface MoyskladVariantForBundle {
  id?: string
  name?: string
  code?: string
  article?: string
  salePrices?: {
    value?: number
    priceType?: {
      id?: string
      name?: string
      meta?: {
        href?: string
        type?: string
        mediaType?: string
      }
    }
  }[]
}

interface MoyskladBundleForOrder {
  id?: string
  name?: string
}

export interface MoyskladStockLossLine {
  productMoyskladId: string
  productName: string
  quantityKg: number
  pricePerKg: number
  sourceLine: string
}

interface PayloadOrderStockLossItem {
  productName?: string
  variantName?: string
  grindOption?: string | null
  quantity?: number | string
  stockProductMoyskladId?: string | null
  stockQuantityKg?: number | string | null
  stockPricePerKg?: number | string | null
}

interface PayloadOrderForStockLoss {
  id: string | number
  orderId?: string
  createdAt?: string
  moyskladStockLossId?: string | null
  items?: PayloadOrderStockLossItem[]
}

const kilogramProductCache = new Map<string, Promise<boolean>>()
const bundleCache = new Map<string, Promise<MoyskladBundleForOrder>>()


function normalizeMoyskladDiscount(value: unknown) {
  const numeric = Number(value) || 0
  const bounded = Math.max(0, Math.min(100, numeric))
  return Math.round(bounded * 100) / 100
}

export class MoyskladTrashedOrderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "MoyskladTrashedOrderError"
  }
}

function isMoyskladTrashOperationError(error: unknown) {
  if (!(error instanceof MoyskladApiError)) return false

  const message = error.message.toLowerCase()
  if (message.includes("находится в корзине") || message.includes("trash")) return true

  const errors = (error.body as { errors?: unknown })?.errors
  if (!Array.isArray(errors)) return false

  return errors.some((item) => {
    if (!item || typeof item !== "object") return false
    const details = item as { error?: unknown; code?: unknown }
    return details.code === 3007 &&
      typeof details.error === "string" &&
      details.error.toLowerCase().includes("находится в корзине")
  })
}

function rubToKopecks(value: number) {
  return Math.round((Number(value) || 0) * 100)
}

function formatMoment(date = new Date()) {
  const pad = (value: number, size = 2) => String(value).padStart(size, "0")
  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    " ",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
    ":",
    pad(date.getSeconds()),
    ".000",
  ].join("")
}

function buildCounterpartyPayload(client: SyncClient, company?: SyncCompany | null) {
  const name = company?.name || client.fullName || client.email || "Клиент 10coffee"
  const result: Record<string, unknown> = {
    name,
    email: company?.contactEmail || client.email || undefined,
    phone: company?.contactPhone || client.phone || undefined,
    description: "Создано автоматически с сайта 10coffee",
  }

  if (company?.inn) result.inn = company.inn
  if (company?.kpp) result.kpp = company.kpp
  if (company?.ogrn) result.ogrn = company.ogrn
  if (company?.legalAddress) result.legalAddress = company.legalAddress
  if (company?.actualAddress) result.actualAddress = company.actualAddress
  if (company?.name) result.legalTitle = company.name

  return result
}

async function updateCompanyCounterpartyId(companyId: string | undefined, counterpartyId: string) {
  if (!companyId) return
  await dbQuery(
    "update public.companies set moysklad_counterparty_id = $1, updated_at = now() where id = $2",
    [counterpartyId, companyId]
  )
}

async function clearCompanyCounterpartyId(companyId: string | undefined) {
  if (!companyId) return
  await dbQuery(
    "update public.companies set moysklad_counterparty_id = null, updated_at = now() where id = $1",
    [companyId]
  )
}

function normalizeInn(value?: string | null) {
  return (value || "").trim()
}

async function findCounterpartyByEmail(email: string) {
  const filter = `email=${email}`
  const result = await moyskladGetList<MoyskladCounterparty>("entity/counterparty", {
    filter,
    limit: 1,
  })
  return result.rows[0] || null
}

async function findCounterpartyByInn(inn: string) {
  const filter = `inn=${inn}`
  const result = await moyskladGetList<MoyskladCounterparty>("entity/counterparty", {
    filter,
    limit: 1,
  })
  return result.rows[0] || null
}

async function findCounterpartyById(id: string) {
  return moyskladRequest<MoyskladCounterparty>(`entity/counterparty/${id}`)
}

function missingMoyskladEntityOrThrow(error: unknown): null {
  if (error instanceof MoyskladApiError && (error.status === 404 || hasMoyskladErrorCode(error, 1021))) return null
  throw error
}

async function updateCounterpartyContactData(id: string, client: SyncClient, company?: SyncCompany | null) {
  return moyskladRequest<MoyskladCounterparty>(`entity/counterparty/${id}`, {
    method: "PUT",
    body: JSON.stringify(buildCounterpartyPayload(client, company)),
  })
}

async function ensureCounterparty(payload: Payload, client: SyncClient, company: SyncCompany | null | undefined, config: MoyskladConfig) {
  assertMoyskladReady(config)

  if (company) {
    if (company.moyskladCounterpartyId) {
      const linkedCounterparty = await findCounterpartyById(company.moyskladCounterpartyId).catch(missingMoyskladEntityOrThrow)
      const linkedInn = normalizeInn(linkedCounterparty?.inn)
      const companyInn = normalizeInn(company.inn)

      if (!companyInn || linkedInn === companyInn) {
        await updateCounterpartyContactData(company.moyskladCounterpartyId, client, company).catch(() => null)
        return company.moyskladCounterpartyId
      }

      await clearCompanyCounterpartyId(company.id)
    }

    if (company.inn) {
      const existing = await findCounterpartyByInn(company.inn)
      const existingId = extractMoyskladId(existing)
      if (existingId) {
        await updateCounterpartyContactData(existingId, client, company).catch(() => null)
        await updateCompanyCounterpartyId(company.id, existingId)
        return existingId
      }
    }

    if (!config.createCounterparties) {
      throw new Error("Контрагент не найден, а создание контрагентов отключено")
    }

    const created = await moyskladRequest<MoyskladCounterparty>("entity/counterparty", {
      method: "POST",
      body: JSON.stringify(buildCounterpartyPayload(client, company)),
    })
    const createdId = extractMoyskladId(created)
    if (!createdId) throw new Error("МойСклад не вернул id контрагента")

    await updateCompanyCounterpartyId(company.id, createdId)
    return createdId
  }

  if (client.moyskladCounterpartyId) {
    await updateCounterpartyContactData(client.moyskladCounterpartyId, client, company).catch(() => null)
    return client.moyskladCounterpartyId
  }

  if (client.email) {
    const existing = await findCounterpartyByEmail(client.email)
    const existingId = extractMoyskladId(existing)
    if (existingId) {
      await updateCounterpartyContactData(existingId, client, company).catch(() => null)
      if (client.id) {
        await payload.update({
          collection: "clients",
          id: client.id,
          data: { moyskladCounterpartyId: existingId },
          overrideAccess: true,
        })
      }
      return existingId
    }
  }

  if (!config.createCounterparties) {
    throw new Error("Контрагент не найден, а создание контрагентов отключено")
  }

  const created = await moyskladRequest<MoyskladCounterparty>("entity/counterparty", {
    method: "POST",
    body: JSON.stringify(buildCounterpartyPayload(client, company)),
  })
  const createdId = extractMoyskladId(created)
  if (!createdId) throw new Error("МойСклад не вернул id контрагента")

  if (client.id) {
    await payload.update({
      collection: "clients",
      id: client.id,
      data: { moyskladCounterpartyId: createdId },
      overrideAccess: true,
    })
  }

  return createdId
}

async function findSalesChannelByName(name: string) {
  const result = await moyskladGetList<MoyskladSalesChannel>("entity/saleschannel", {
    filter: `name=${name}`,
    limit: 1,
  })
  return result.rows[0] || null
}

async function ensureSalesChannel(config: MoyskladConfig) {
  if (config.salesChannelId) return config.salesChannelId
  if (!config.salesChannelName) return null

  const existing = await findSalesChannelByName(config.salesChannelName)
  const existingId = extractMoyskladId(existing)
  if (existingId) return existingId

  if (!config.createSalesChannel) return null

  const created = await moyskladRequest<MoyskladSalesChannel>("entity/saleschannel", {
    method: "POST",
    body: JSON.stringify({
      name: config.salesChannelName,
      type: config.salesChannelType,
      description: config.channel === "wholesale"
        ? "Оптовые заказы кабинета 10coffee"
        : "Розничные заказы интернет-магазина 10coffee",
    }),
  })

  return extractMoyskladId(created)
}

function buildOrderDescription(order: SyncOrder, company?: SyncCompany | null) {
  const deliveryMethodLabel = order.deliveryMethod
    ? DELIVERY_METHOD_LABELS[order.deliveryMethod] || order.deliveryMethod
    : ""
  const rows = [
    `Заказ сайта: ${order.orderId || order.id}`,
    order.customerType === "individual" ? "Тип заказа: розничный (shop.10coffee.ru)" : "",
    company?.name ? `Компания: ${company.name}` : "",
    company?.inn ? `ИНН: ${company.inn}` : "",
    deliveryMethodLabel ? `Доставка: ${deliveryMethodLabel}` : "",
    order.deliveryAddress ? `Адрес: ${order.deliveryAddress}` : "",
    order.comment ? `Комментарий: ${order.comment}` : "",
  ].filter(Boolean)

  return rows.join("\n")
}

function buildOrderDescriptionWithComposition(
  order: SyncOrder,
  company?: SyncCompany | null,
  compositionLines: string[] = []
) {
  const description = buildOrderDescription(order, company)
  if (compositionLines.length === 0) return description

  return [
    description,
    "Состав заказа:",
    ...compositionLines.map((line) => `- ${line}`),
  ].filter(Boolean).join("\n")
}

function getSkippedPositionReason(item: CartItem) {
  if (isCoffeeWeightAccountingItem(item) && !item.variant?.moysklad_id) {
    return "нужен ID модификации МойСклад для комплекта"
  }

  return "не заполнен moyskladId"
}

function resolveAssortment(item: CartItem) {
  const variant = item.variant as (CartItem["variant"] & {
    moysklad_id?: string | null
    moysklad_type?: "product" | "variant" | "service" | null
  }) | undefined
  const product = item.product as (CartItem["product"] & {
    moysklad_id?: string | null
  }) | undefined

  if (variant?.moysklad_id) {
    return {
      id: variant.moysklad_id,
      type: variant.moysklad_type || "variant",
    }
  }

  if (product?.moysklad_id) {
    return {
      id: product.moysklad_id,
      type: "product" as const,
    }
  }

  return null
}

function isCoffeeWeightAccountingItem(item: CartItem) {
  return Boolean(
    item.product?.product_type_schema === "coffee" &&
    item.product?.moysklad_id &&
    item.variant?.weight_grams &&
    item.variant.weight_grams > 0
  )
}

function normalizeUomName(value?: string | null) {
  return (value || "").trim().toLowerCase().replace(/ё/g, "е")
}

async function isKilogramProduct(moyskladProductId: string) {
  const cached = kilogramProductCache.get(moyskladProductId)
  if (cached) return cached

  const promise = moyskladRequest<MoyskladProductUomResponse>(
    `entity/product/${moyskladProductId}?expand=uom`
  )
    .then((product) => {
      const uomName = normalizeUomName(product.uom?.name)
      return uomName === "кг" || uomName.includes("килограмм")
    })
    .catch((error) => {
      // An unavailable API says nothing about the unit of measurement.
      kilogramProductCache.delete(moyskladProductId)
      throw error
    })

  kilogramProductCache.set(moyskladProductId, promise)
  return promise
}

function shouldUseBundleAccounting(item: CartItem, productMoyskladId: string) {
  return Boolean(
    productMoyskladId &&
    isCoffeeWeightAccountingItem(item) &&
    item.variant?.moysklad_id
  )
}

async function getMoyskladVariantForBundle(variantMoyskladId: string) {
  return moyskladRequest<MoyskladVariantForBundle>(`entity/variant/${variantMoyskladId}`)
    .catch(missingMoyskladEntityOrThrow)
}

async function getMoyskladProductForBundle(productMoyskladId: string) {
  return moyskladRequest<MoyskladProductUomResponse>(`entity/product/${productMoyskladId}`)
    .catch(missingMoyskladEntityOrThrow)
}

async function ensureBundleForWeightAccountingItem(
  item: CartItem,
  productMoyskladId: string,
  weightGrams: number
) {
  const variantMoyskladId = item.variant?.moysklad_id || null
  if (!variantMoyskladId) {
    throw new Error(`У варианта ${item.variant?.name || item.variant_id} нет ID модификации МойСклад`)
  }

  const cacheKey = [
    productMoyskladId,
    variantMoyskladId,
    weightGrams,
    item.variant?.price ?? 0,
    item.variant?.name || "",
    item.grind_option || "",
  ].join(":")
  const cached = bundleCache.get(cacheKey)
  if (cached) return cached

  const promise = (async () => {
    const [moyskladVariant, moyskladProduct] = await Promise.all([
      getMoyskladVariantForBundle(variantMoyskladId),
      getMoyskladProductForBundle(productMoyskladId),
    ])

    return ensureMoyskladBundleForVariant({
      productMoyskladId,
      variantMoyskladId,
      variantName: moyskladVariant?.name || `${item.product?.name || item.product_id} (${item.variant?.name || item.variant_id}${getCartItemGrindLabel(item)})`,
      variantCode: moyskladVariant?.code || item.variant?.sku,
      variantArticle: moyskladVariant?.article || item.variant?.sku,
      salePrices: moyskladVariant?.salePrices,
      productFolder: moyskladProduct?.productFolder,
      weightGrams,
      priceRub: item.variant?.price ?? 0,
    })
  })().catch((error) => {
    // A failed attempt must not poison subsequent manual/background retries.
    bundleCache.delete(cacheKey)
    throw error
  })

  bundleCache.set(cacheKey, promise)
  return promise
}

function getCartItemGrindLabel(item: CartItem) {
  const grind = item.grind_option || item.variant?.grind_options?.[0] || ""
  return grind ? `, ${grind}` : ""
}

function formatWeightFromGrams(grams: number) {
  if (!Number.isFinite(grams) || grams <= 0) return ""
  if (grams >= 1000 && grams % 1000 === 0) return `${grams / 1000} кг`
  if (grams >= 1000) return `${Number((grams / 1000).toFixed(3))} кг`
  return `${grams} г`
}

export function buildMoyskladStockLossLines(cartItems: CartItem[]) {
  const lines: MoyskladStockLossLine[] = []

  for (const item of cartItems) {
    const productMoyskladId = item.product?.moysklad_id || null
    if (!isCoffeeWeightAccountingItem(item) || !productMoyskladId) continue

    const weightGrams = Number(item.variant?.weight_grams) || 0
    const weightKgPerPack = weightGrams / 1000
    const quantityKg = weightKgPerPack * item.quantity
    const variantPriceKopecks = rubToKopecks(item.variant?.price ?? 0)
    const pricePerKg = weightKgPerPack > 0
      ? Math.round(variantPriceKopecks / weightKgPerPack)
      : 0

    if (quantityKg <= 0 || pricePerKg <= 0) continue

    lines.push({
      productMoyskladId,
      productName: item.product?.name || item.product_id,
      quantityKg: Number(quantityKg.toFixed(6)),
      pricePerKg,
      sourceLine: `${item.product?.name || item.product_id}: ${item.variant?.name || item.variant_id}${getCartItemGrindLabel(item)} ×${item.quantity} (${formatWeightFromGrams(weightGrams * item.quantity)})`,
    })
  }

  return lines
}

async function buildCustomerPositions(
  cartItems: CartItem[],
  deliveryCost: number,
  discountLines: MoyskladDiscountLine[] = [],
  positionVat = 0,
  config: MoyskladConfig,
) {
  const discountByItem = new Map(
    discountLines.map((line) => [
      line.cartItemId,
      normalizeMoyskladDiscount(line.discountPercent),
    ])
  )

  const skipped: CartItem[] = []
  const positions: MoyskladOrderPositionPayload[] = []
  const compositionLines: string[] = []
  for (const item of cartItems) {
    const productMoyskladId = item.product?.moysklad_id || null
    const weightGrams = Number(item.variant?.weight_grams) || 0

    if (productMoyskladId && shouldUseBundleAccounting(item, productMoyskladId)) {
      const bundle = await ensureBundleForWeightAccountingItem(item, productMoyskladId, weightGrams)
      if (!bundle.id) {
        throw new Error(`Не удалось создать комплект для ${item.variant?.name || item.variant_id}`)
      }

      const position: MoyskladOrderPositionPayload = {
        quantity: item.quantity,
        price: rubToKopecks(item.variant?.price ?? 0),
        assortment: {
          meta: moyskladMeta("bundle", bundle.id),
        },
      }

      const discount = discountByItem.get(item.id) || 0
      if (discount > 0) position.discount = discount
      if (positionVat > 0) position.vat = positionVat

      positions.push(position)
      compositionLines.push(
        `${item.product?.name || item.product_id}: ${item.variant?.name || item.variant_id}${getCartItemGrindLabel(item)} ×${item.quantity} (${formatWeightFromGrams(weightGrams * item.quantity)})`
      )
      continue
    }

    if (
      isCoffeeWeightAccountingItem(item) &&
      productMoyskladId &&
      await isKilogramProduct(productMoyskladId)
    ) {
      skipped.push(item)
      continue
    }

    const assortment = resolveAssortment(item)
    if (!assortment) {
      skipped.push(item)
      continue
    }

    const position: MoyskladOrderPositionPayload = {
      quantity: item.quantity,
      price: rubToKopecks(item.variant?.price ?? 0),
      assortment: {
        meta: moyskladMeta(assortment.type, assortment.id),
      },
    }

    const discount = discountByItem.get(item.id) || 0
    if (discount > 0) position.discount = discount
    if (positionVat > 0) position.vat = positionVat

    positions.push(position)
  }

  if (deliveryCost > 0) {
    if (!config.deliveryServiceId) {
      throw new Error("Для передачи доставки в МойСклад нужен MOYSKLAD_DELIVERY_SERVICE_ID")
    }

    const deliveryPosition: MoyskladOrderPositionPayload = {
      quantity: 1,
      price: rubToKopecks(deliveryCost),
      assortment: {
        meta: moyskladMeta("service", config.deliveryServiceId),
      },
    }

    if (positionVat > 0) deliveryPosition.vat = positionVat
    positions.push(deliveryPosition)
  }

  return { positions, skipped, compositionLines }
}

function buildDocumentRefs(params: {
  counterpartyId: string
  positions: MoyskladOrderPositionPayload[]
  description: string
  shipmentAddress?: string | null
  salesChannelId?: string | null
  createdAt?: string
}, config: MoyskladConfig) {
  const orderDate = params.createdAt ? new Date(params.createdAt) : undefined
  const body: Record<string, unknown> = {
    moment: formatMoment(orderDate),
    applicable: true,
    vatEnabled: config.vatEnabled,
    vatIncluded: config.vatIncluded,
    organization: {
      meta: moyskladMeta("organization", config.organizationId!),
    },
    agent: {
      meta: moyskladMeta("counterparty", params.counterpartyId),
    },
    positions: params.positions,
    description: params.description,
  }

  if (config.storeId) body.store = { meta: moyskladMeta("store", config.storeId) }
  if (config.projectId) body.project = { meta: moyskladMeta("project", config.projectId) }
  if (config.contractId) body.contract = { meta: moyskladMeta("contract", config.contractId) }
  if (params.salesChannelId) body.salesChannel = { meta: moyskladMeta("saleschannel", params.salesChannelId) }
  if (params.shipmentAddress) body.shipmentAddress = params.shipmentAddress

  return body
}

async function findCustomerOrderByExternalCode(externalCode: string) {
  const result = await moyskladGetList<MoyskladCustomerOrder>("entity/customerorder", {
    filter: `externalCode=${externalCode}`,
    limit: 2,
  })

  if (result.rows.length > 1 || result.meta?.size > 1) throw new Error("Несколько заказов МойСклад имеют один внешний код; выгрузка остановлена")
  return result.rows[0] || null
}

async function findInvoiceOutByExternalCode(externalCode: string) {
  const result = await moyskladGetList<MoyskladInvoiceOut>("entity/invoiceout", {
    filter: `externalCode=${externalCode}`,
    limit: 2,
  })

  if (result.rows.length > 1 || result.meta?.size > 1) throw new Error("Несколько счетов МойСклад имеют один внешний код; выгрузка остановлена")
  return result.rows[0] || null
}

async function readExistingOrder(order: SyncOrder, config: MoyskladConfig) {
  const code = orderExternalCode(order)
  if (order.moyskladCustomerOrderId) {
    // An invalid saved link must be repaired explicitly. Never silently
    // unlink/recreate an order because its old UUID is missing or in trash.
    return moyskladRequest<MoyskladCustomerOrder>(`entity/customerorder/${order.moyskladCustomerOrderId}`)
  }
  const current = await findCustomerOrderByExternalCode(code)
  if (current) return current
  const legacy = await findCustomerOrderByExternalCode(String(order.id))
  // A numeric-ID collision is not this site's order. Keep the old document
  // intact and create the new order under its durable key instead.
  if (!legacy || legacy.name !== order.orderId) return null
  assertRemoteOrderIdentity(legacy, order, config.organizationId)
  return legacy
}

async function readExistingInvoice(order: SyncOrder, customerOrderId: string | null, counterpartyId: string, config: MoyskladConfig) {
  let invoice: MoyskladInvoiceOut | null
  try {
    invoice = order.moyskladInvoiceOutId
      ? await moyskladRequest<MoyskladInvoiceOut>(`entity/invoiceout/${order.moyskladInvoiceOutId}`)
      : await findInvoiceOutByExternalCode(`${order.orderId}-invoice`)
  } catch (error) {
    if (isMoyskladTrashOperationError(error)) {
      throw new MoyskladTrashedOrderError(`Счёт к заказу ${order.orderId} находится в корзине МойСклад. Восстановите его и проверьте связь`)
    }
    throw error
  }
  if (invoice) assertRemoteInvoiceIdentity(invoice, order.orderId!, customerOrderId || "", config.organizationId, counterpartyId)
  return invoice
}

function documentUniquenessConflict(label: string) {
  // Code 3006 proves a uniqueness conflict, not that a document is trashed.
  // Documents do not support archived=true; restoring trash requires the UI.
  return new Error(
    `${label}: конфликт уникальности в МойСклад (код 3006). ` +
    "Проверьте существующий документ с этим номером, включая корзину, и его связь с заказом сайта. " +
    "После устранения конфликта повторите выгрузку."
  )
}

async function createInvoiceOut(params: {
  order: SyncOrder
  counterpartyId: string
  moyskladOrderId: string
  positions: MoyskladOrderPositionPayload[]
  description: string
  shipmentAddress?: string | null
  salesChannelId?: string | null
  config: MoyskladConfig
}) {
  const externalCode = `${params.order.orderId || params.order.id}-invoice`
  const invoiceBody = {
    ...buildDocumentRefs({
      counterpartyId: params.counterpartyId,
      positions: params.positions,
      description: params.description,
      shipmentAddress: params.shipmentAddress,
      salesChannelId: params.salesChannelId,
      createdAt: params.order.createdAt,
    }, params.config),
    externalCode,
    customerOrder: {
      meta: moyskladMeta("customerorder", params.moyskladOrderId),
    },
  }

  const existingInvoice = await readExistingInvoice(params.order, params.moyskladOrderId, params.counterpartyId, params.config)
  const invoiceId = extractMoyskladId(existingInvoice)

  if (invoiceId) {
    try {
      const updated = await moyskladRequest<MoyskladInvoiceOut>(`entity/invoiceout/${invoiceId}`, {
        method: "PUT",
        body: JSON.stringify(invoiceBody),
      })

      return {
        invoice: updated,
        invoiceId,
        payload: invoiceBody,
        reused: true as const,
      }
    } catch (error) {
      if (isMoyskladTrashOperationError(error)) {
        throw new MoyskladTrashedOrderError(
          `Счёт к заказу ${params.order.orderId || params.order.id} находится в корзине МойСклад. Восстановите его в МойСклад и повторите выгрузку.`
        )
      } else {
        throw error
      }
    }
  }

  try {
    const created = await moyskladRequest<MoyskladInvoiceOut>("entity/invoiceout", {
      method: "POST",
      body: JSON.stringify(invoiceBody),
    })

    return {
      invoice: created,
      invoiceId: extractMoyskladId(created),
      payload: invoiceBody,
    }
  } catch (error) {
    if (!hasMoyskladErrorCode(error, 3006)) throw error

    // A concurrent export may have created this same invoice after our lookup.
    const conflicting = await findInvoiceOutByExternalCode(externalCode)
    const conflictingId = extractMoyskladId(conflicting)
    if (conflictingId) {
      assertRemoteInvoiceIdentity(conflicting!, params.order.orderId!, params.moyskladOrderId, params.config.organizationId, params.counterpartyId)
      const updated = await moyskladRequest<MoyskladInvoiceOut>(`entity/invoiceout/${conflictingId}`, {
        method: "PUT",
        body: JSON.stringify(invoiceBody),
      })

      return {
        invoice: updated,
        invoiceId: conflictingId,
        payload: invoiceBody,
        reused: true as const,
      }
    }

    throw documentUniquenessConflict(`Счёт к заказу ${params.order.orderId || params.order.id}`)
  }
}

function buildStockLossExternalCode(order: PayloadOrderForStockLoss) {
  return `10coffee-stock-loss-${order.id}`
}

function getStoredStockLossPositions(order: PayloadOrderForStockLoss) {
  const positionsByKey = new Map<string, MoyskladOrderPositionPayload>()
  const compositionLines: string[] = []

  for (const item of order.items || []) {
    const productMoyskladId = item.stockProductMoyskladId?.trim()
    const quantityKg = Number(item.stockQuantityKg) || 0
    const pricePerKg = Math.round(Number(item.stockPricePerKg) || 0)
    if (!productMoyskladId || quantityKg <= 0 || pricePerKg <= 0) continue

    const key = `${productMoyskladId}:${pricePerKg}`
    const existing = positionsByKey.get(key)
    if (existing) {
      existing.quantity = Number((existing.quantity + quantityKg).toFixed(6))
    } else {
      positionsByKey.set(key, {
        quantity: Number(quantityKg.toFixed(6)),
        price: pricePerKg,
        assortment: {
          meta: moyskladMeta("product", productMoyskladId),
        },
      })
    }

    const parts = [
      item.productName || "Товар",
      item.variantName ? `(${item.variantName})` : "",
      item.grindOption ? `, ${item.grindOption}` : "",
      `×${Number(item.quantity) || 0}`,
      `(${Number(quantityKg.toFixed(3))} кг)`,
    ].filter(Boolean)
    compositionLines.push(parts.join(" "))
  }

  return {
    positions: [...positionsByKey.values()],
    compositionLines,
  }
}

async function findStockLossByExternalCode(externalCode: string) {
  const result = await moyskladGetList<MoyskladLoss>("entity/loss", {
    filter: `externalCode=${externalCode}`,
    limit: 1,
  })

  return result.rows[0] || null
}

export async function ensureMoyskladStockLossForOrder(
  payload: Payload,
  order: PayloadOrderForStockLoss
) {
  const config = getMoyskladConfig()
  if (!config.enabled) {
    return { skipped: true as const, reason: "MOYSKLAD_ENABLED не включен" }
  }
  assertMoyskladReady(config)


  if (order.moyskladStockLossId) {
    return { skipped: true as const, moyskladStockLossId: order.moyskladStockLossId }
  }

  if (!config.storeId) {
    throw new Error("Для технического списания нужен MOYSKLAD_STORE_ID")
  }

  const { positions, compositionLines } = getStoredStockLossPositions(order)
  if (positions.length === 0) {
    return { skipped: true as const, reason: "Нет весовых позиций для списания" }
  }

  const externalCode = buildStockLossExternalCode(order)
  const existing = await findStockLossByExternalCode(externalCode)
  const existingId = extractMoyskladId(existing)

  if (existingId) {
    await payload.update({
      collection: "orders",
      id: order.id,
      data: {
        moyskladStockLossId: existingId,
        moyskladStockLossSyncedAt: new Date().toISOString(),
        moyskladStockLossError: "",
      },
      overrideAccess: true,
    })

    return { success: true as const, moyskladStockLossId: existingId, reused: true as const }
  }

  const description = [
    `Техническое списание по заказу ${order.orderId || order.id}`,
    "Состав заказа:",
    ...compositionLines.map((line) => `- ${line}`),
  ].join("\n")

  const stockLossDate = order.createdAt ? new Date(order.createdAt) : undefined
  const body = {
    moment: formatMoment(stockLossDate),
    applicable: true,
    externalCode,
    organization: {
      meta: moyskladMeta("organization", config.organizationId!),
    },
    store: {
      meta: moyskladMeta("store", config.storeId),
    },
    description,
    positions,
  }

  const created = await moyskladRequest<MoyskladLoss>("entity/loss", {
    method: "POST",
    body: JSON.stringify(body),
  })
  const moyskladStockLossId = extractMoyskladId(created)
  if (!moyskladStockLossId) throw new Error("МойСклад не вернул id технического списания")

  await payload.update({
    collection: "orders",
    id: order.id,
    data: {
      moyskladStockLossId,
      moyskladStockLossSyncedAt: new Date().toISOString(),
      moyskladStockLossError: "",
    },
    overrideAccess: true,
  })

  await writeMoyskladLog({
    entityType: "stock_loss",
    localId: order.id,
    moyskladId: moyskladStockLossId,
    direction: "site_to_moysklad",
    status: "success",
    payload: body,
    response: created,
  })

  return { success: true as const, moyskladStockLossId }
}

export async function syncOrderToMoysklad(params: SyncOrderParams) {
  if (!canExportOrderToMoysklad(params.order)) {
    return { skipped: true as const }
  }
  const salesChannel: SalesChannel = params.order.salesChannel || (params.order.customerType === "individual" ? "retail" : "wholesale")
  const config = getMoyskladConfig(salesChannel)
  // The Runtime switch is a kill switch, including payment webhooks and
  // forced maintenance. A retry may refresh unchanged content, not bypass it.
  if (!config.enabled || !config.syncOrdersOnCreate) {
    return { skipped: true as const }
  }

  const orderId = params.order.id
  let counterpartyIdForUpdate: string | null = null
  let moyskladOrderIdForUpdate: string | null = null
  let moyskladInvoiceOutIdForUpdate: string | null = null

  try {
    assertMoyskladReady(config)
    const externalCode = orderExternalCode(params.order)
    let existingOrder: MoyskladCustomerOrder | null
    try {
      existingOrder = await readExistingOrder(params.order, config)
    } catch (error) {
      if (isMoyskladTrashOperationError(error)) {
        throw new MoyskladTrashedOrderError(`Заказ ${params.order.orderId} находится в корзине МойСклад, пропущен`)
      }
      throw error
    }
    if (existingOrder) {
      assertRemoteOrderIdentity(existingOrder, params.order, config.organizationId)
      assertRemoteOrderTotalsConsistent(existingOrder)
    }

    await params.payload.update({
      collection: "orders",
      id: orderId,
      data: {
        moyskladSyncStatus: "pending",
        moyskladSyncError: "",
      },
      overrideAccess: true,
    })


    const counterpartyId = await ensureCounterparty(params.payload, params.client, params.company, config)
    counterpartyIdForUpdate = counterpartyId
    if (existingOrder) assertRemoteOrderIdentity(existingOrder, params.order, config.organizationId, counterpartyId)
    // Validate a saved invoice before changing the order it purports to belong
    // to. A conflicting invoice must not leave a half-updated customer order.
    if (params.order.moyskladInvoiceOutId || (config.createInvoiceOnOrder && existingOrder)) {
      await readExistingInvoice(params.order, extractMoyskladId(existingOrder), counterpartyId, config)
    }
    const salesChannelId = await ensureSalesChannel(config)
    let positionVat = config.defaultVat
    if (config.vatEnabled && positionVat <= 0) {
      try {
        const siteSettings = await params.payload.findGlobal({ slug: "site-settings" })
        positionVat = Number((siteSettings as { vatPercent?: number | string }).vatPercent) || 0
      } catch {
        positionVat = 0
      }
    }
    if (!config.vatEnabled) positionVat = 0

    const { positions: originalPositions, skipped, compositionLines } = await buildCustomerPositions(
      params.cartItems,
      Number(params.order.deliveryCost) || 0,
      params.discountLines || [],
      positionVat,
      config,
    )

    if (skipped.length > 0) {
      const names = skipped.map((item) => {
        const label = `${item.product?.name || item.product_id} / ${item.variant?.name || item.variant_id}`
        return `${label} (${getSkippedPositionReason(item)})`
      })
      throw new Error(`Позиции не готовы к выгрузке в МойСклад: ${names.join(", ")}`)
    }

    if (originalPositions.length === 0) {
      throw new Error("Нет позиций для отправки в МойСклад")
    }

    const positions = reconcileMoyskladOrderTotals(
      originalPositions, params.cartItems.map(item => item.id), params.discountLines || [], params.order.total, params.order.subtotal,
    )

    const description = buildOrderDescriptionWithComposition(
      params.order,
      params.company,
      compositionLines
    )
    const body: Record<string, unknown> = {
      ...buildDocumentRefs({
        counterpartyId,
        positions,
        description,
        shipmentAddress: params.order.deliveryAddress,
        salesChannelId,
        createdAt: params.order.createdAt,
      }, config),
      name: params.order.orderId || String(orderId),
      externalCode: existingOrder?.externalCode || externalCode,
    }

    if (config.defaultOrderStateId) {
      body.state = { meta: moyskladMeta("state", config.defaultOrderStateId) }
    }

    let orderResponse: MoyskladCustomerOrder | null = null
    let orderMessage: string | undefined
    let moyskladOrderId = extractMoyskladId(existingOrder)

    if (moyskladOrderId) {
      delete body.state
      try {
        orderResponse = await moyskladRequest<MoyskladCustomerOrder>(`entity/customerorder/${moyskladOrderId}`, {
          method: "PUT",
          body: JSON.stringify(body),
        })
        orderMessage = "Заказ уже существовал в МойСклад, позиции и суммы обновлены"
      } catch (error) {
        if (isMoyskladTrashOperationError(error)) {
          throw new MoyskladTrashedOrderError(
            `Заказ ${params.order.orderId || String(orderId)} находится в корзине МойСклад, пропущен`
          )
        }
        throw error
      }
    }

    if (!moyskladOrderId) {
      try {
        orderResponse = await moyskladRequest<MoyskladCustomerOrder>("entity/customerorder", {
          method: "POST",
          body: JSON.stringify(body),
        })
      } catch (error) {
        if (!hasMoyskladErrorCode(error, 3006)) throw error

        // A concurrent create is reusable only after verifying its complete
        // identity. Neither a numeric local ID nor a name alone authorizes PUT.
        const conflicting = await findCustomerOrderByExternalCode(externalCode)
        const conflictingId = extractMoyskladId(conflicting)
        if (conflictingId) {
          assertRemoteOrderIdentity(conflicting!, params.order, config.organizationId, counterpartyId)
          assertRemoteOrderTotalsConsistent(conflicting!)
          delete body.state
          body.externalCode = conflicting!.externalCode || externalCode
          orderResponse = await moyskladRequest<MoyskladCustomerOrder>(`entity/customerorder/${conflictingId}`, {
            method: "PUT",
            body: JSON.stringify(body),
          })
          moyskladOrderId = conflictingId
          orderMessage = "Заказ найден по внешнему коду после конфликта создания, позиции и суммы обновлены"
        } else {
          throw documentUniquenessConflict(`Заказ ${params.order.orderId || String(orderId)}`)
        }
      }
      moyskladOrderId = moyskladOrderId || extractMoyskladId(orderResponse)
    }

    moyskladOrderIdForUpdate = moyskladOrderId
    assertMoyskladDocumentTotal(orderResponse, params.order.total)

    await writeMoyskladLog({
      entityType: "order",
      localId: orderId,
      moyskladId: moyskladOrderId,
      direction: "site_to_moysklad",
      status: "success",
      message: orderMessage,
      payload: body,
      response: orderResponse || undefined,
    })

    let moyskladInvoiceOutId: string | null = null
    let invoiceResponse: MoyskladInvoiceOut | null = null
    let invoicePayload: Record<string, unknown> | null = null

    // Retail orders are only reservations until payment and fulfilment are
    // confirmed. They must not create a B2B invoice automatically.
    if (config.createInvoiceOnOrder && params.order.customerType !== "individual" && moyskladOrderId) {
      const invoiceResult = await createInvoiceOut({
        order: params.order,
        counterpartyId,
        moyskladOrderId,
        positions,
        description,
        shipmentAddress: params.order.deliveryAddress,
        salesChannelId,
        config,
      })
      if (invoiceResult) {
        moyskladInvoiceOutId = invoiceResult.invoiceId
        moyskladInvoiceOutIdForUpdate = moyskladInvoiceOutId
        invoiceResponse = invoiceResult.invoice
        invoicePayload = invoiceResult.payload
        assertMoyskladDocumentTotal(invoiceResponse, params.order.total)
      }
    }

    const updateData: Record<string, unknown> = {
      moyskladCounterpartyId: counterpartyId,
      moyskladCustomerOrderId: moyskladOrderId,
      moyskladInvoiceOutId,
      moyskladSyncStatus: "synced",
      moyskladSyncError: "",
      moyskladSyncedAt: new Date().toISOString(),
    }
    if (moyskladInvoiceOutId) {
      updateData.paymentStatus = "invoiced"
    }

    // Store a content hash of the order as it was successfully synced. The
    // "Повторить/обновить выгрузку" action uses it to skip orders that are
    // already in MoySklad and unchanged, instead of re-pushing every order.
    try {
      const storedOrder = await params.payload.findByID({
        collection: "orders",
        id: orderId,
        depth: 0,
        overrideAccess: true,
      })
      updateData.moyskladSyncedHash = computeOrderContentHash(storedOrder as Parameters<typeof computeOrderContentHash>[0])
    } catch {
      // Non-fatal: if the hash cannot be computed the order will simply be
      // re-synced on the next manual retry.
    }

    await params.payload.update({
      collection: "orders",
      id: orderId,
      data: updateData,
      overrideAccess: true,
    })

    if (moyskladInvoiceOutId) {
      await writeMoyskladLog({
        entityType: "invoice",
        localId: orderId,
        moyskladId: moyskladInvoiceOutId,
        direction: "site_to_moysklad",
        status: "success",
        payload: invoicePayload || undefined,
        response: invoiceResponse || undefined,
      })
    }

    return { success: true as const, moyskladOrderId, moyskladInvoiceOutId }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Ошибка синхронизации с МойСклад"
    // Only an explicit trash response is marked as skipped. A uniqueness
    // conflict remains an unresolved error until the documents are reconciled.
    const isTrashedConflict = error instanceof MoyskladTrashedOrderError

    const errorData: Record<string, unknown> = {
      moyskladSyncStatus: "error",
      moyskladSyncError: message,
    }
    if (counterpartyIdForUpdate) errorData.moyskladCounterpartyId = counterpartyIdForUpdate
    if (moyskladOrderIdForUpdate) errorData.moyskladCustomerOrderId = moyskladOrderIdForUpdate
    if (moyskladInvoiceOutIdForUpdate) errorData.moyskladInvoiceOutId = moyskladInvoiceOutIdForUpdate

    await params.payload.update({
      collection: "orders",
      id: orderId,
      data: errorData,
      overrideAccess: true,
    })

    await writeMoyskladLog({
      entityType: "order",
      localId: orderId,
      direction: "site_to_moysklad",
      status: "error",
      message,
    })

    console.error("[MoySklad] order sync failed:", message)
    return { error: message, trashed: isTrashedConflict }
  }
}
