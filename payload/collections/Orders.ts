import type { Access, CollectionConfig, Where } from "payload"
import { calculateOrderLineDiscounts } from "@/lib/order-line-discounts"
import { dbQuery } from "@/lib/db"
import { getMoyskladConfig } from "@/lib/moysklad/config"
import { retryFailedMoyskladOrders } from "@/lib/moysklad/order-retry"
import { handleOrderLinkRepair } from "@/lib/moysklad/order-link-endpoint"
import { canReadOperations, canRunIntegrations, getAllowedSalesChannels, operationsCreateAccess, operationsDeleteAccess, operationsUpdateAccess } from "../access/adminRoles"
import { orderWorkspaceBaseFilter } from "../admin/workspace"
import { accrueLoyaltyForDeliveredOrder, releaseLoyaltyReservation, reverseLoyaltyForReturnedOrder } from "@/lib/loyalty"
import { sendCdekTrackingEmail } from "@/lib/cdek-tracking-email"

async function generateSequentialOrderId() {
  const nextResult = await dbQuery<{ next_number: number }>(
    "select nextval('public.order_number_seq')::int as next_number;"
  )
  const nextNumber = Number(nextResult.rows[0]?.next_number) || 1

  return `10C-${String(nextNumber).padStart(5, "0")}`
}

const ordersReadAccess: Access = ({ req }) => {
  if (!canReadOperations(req.user)) return false
  const channels = getAllowedSalesChannels(req.user)
  const visible: Where[] = []
  if (channels.includes("wholesale")) visible.push({ salesChannel: { equals: "wholesale" } })
  if (channels.includes("retail")) visible.push({ salesChannel: { equals: "retail" } })
  if (visible.length === 0) return false
  return visible.length === 1 ? visible[0] : { or: visible }
}

export const Orders: CollectionConfig = {
  slug: "orders",
  admin: {
    useAsTitle: "orderId",
    group: "Заказы и продажи",
    description: "Заказы клиентов",
    baseFilter: orderWorkspaceBaseFilter,
    listSearchableFields: [
      "orderId",
      "customerFullName",
      "customerEmail",
      "customerPhone",
      "companyName",
      "companyInn",
    ],
    defaultColumns: [
      "orderId",
      "salesChannel",
      "customerFullName",
      "status",
      "paymentMethod",
      "paymentStatus",
      "deliveryMethod",
      "total",
      "createdAt",
    ],
    components: {
      beforeList: ["/payload/components/MoyskladOrderRetryButton"],
    },
  },
  labels: {
    singular: "Заказ",
    plural: "Заказы",
  },

  endpoints: [
    { path: "/moysklad/relink", method: "post", handler: handleOrderLinkRepair },
    {
      path: "/moysklad/retry",
      method: "post",
      handler: async (req) => {
        if (!canRunIntegrations(req.user)) {
          return Response.json({ ok: false, error: "Недостаточно прав" }, { status: 403 })
        }

        const config = getMoyskladConfig()
        if (!config.enabled || !config.syncOrdersOnCreate) {
          return Response.json({ ok: false, error: "Выгрузка заказов в МойСклад отключена" }, { status: 400 })
        }

        let orderIds: (string | number)[] | undefined
        try {
          const body = await req.json?.()
          if (Array.isArray(body?.orderIds) && body.orderIds.length > 0) {
            orderIds = body.orderIds
          }
        } catch {
          // No/invalid JSON body — fall back to the full background sweep.
        }

        const encoder = new TextEncoder()
        const stream = new ReadableStream({
          async start(controller) {
            const send = (data: Record<string, unknown>) => {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
            }

            try {
              const result = await retryFailedMoyskladOrders(req.payload, {
                includeAllUnexported: true,
                includeExisting: true,
                minAgeMs: 0,
                orderIds,
                onProgress: (event) => send({ ...event }),
              })
              send({ type: "final", ok: result.failed === 0, ...result })
            } catch (error) {
              send({
                type: "final",
                ok: false,
                error: error instanceof Error
                  ? error.message
                  : "Не удалось повторить выгрузку заказов в МойСклад",
              })
            } finally {
              controller.close()
            }
          },
        })

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        })
      },
    },
  ],
  hooks: {
    beforeChange: [
      async ({ data, operation, req, originalDoc }) => {
        if (operation === "create" && data && !data.orderId) {
          data.orderId = await generateSequentialOrderId()
        }

        if (operation === "create" && data && !data.salesChannel) {
          data.salesChannel = data.customerType === "individual" ? "retail" : "wholesale"
        }

        if (data) {
          const previousPaymentStatus = String(originalDoc?.paymentStatus || "")
          const nextPaymentStatus = String(data.paymentStatus ?? previousPaymentStatus)
          const nextOrderStatus = String(data.status ?? originalDoc?.status ?? "")

          // Keep the business status consistent when an administrator closes
          // an unpaid payment manually. A later authoritative YooKassa
          // `succeeded` webhook may safely reopen it as paid below.
          if (
            !req.context?.moyskladStatusSync
            && ["cancelled", "failed"].includes(nextPaymentStatus)
            && !["paid", "refunded"].includes(previousPaymentStatus)
            && ["new", "confirmed", "invoiced"].includes(nextOrderStatus)
          ) {
            data.status = "cancelled"
          }

          // Do not leave an order cancelled if YooKassa subsequently confirms
          // a payment that was still pending when it was closed locally.
          if (
            !req.context?.moyskladStatusSync
            && nextPaymentStatus === "paid"
            && previousPaymentStatus !== "paid"
            && ["new", "confirmed", "invoiced", "cancelled"].includes(nextOrderStatus)
          ) {
            data.status = "paid"
          }

          const subtotal = Number(data.subtotal ?? originalDoc?.subtotal) || 0
          const discountPercent = Number(data.discountPercent ?? originalDoc?.discountPercent) || 0

          if (discountPercent > 0) {
            data.discountAmount = Math.round((subtotal * discountPercent) / 100)

            // An order-level discount is represented by per-position discounts
            // in the admin UI and in МойСклад. Keep those values in sync even
            // when an order is created through the API rather than this form.
            const items = Array.isArray(data.items)
              ? data.items
              : Array.isArray(originalDoc?.items)
                ? originalDoc.items
                : []
            const lineDiscounts = calculateOrderLineDiscounts(items, discountPercent)
            data.items = items.map((item: Record<string, unknown>, index: number) => ({
              ...item,
              discountPercent: lineDiscounts[index]?.discountPercent || 0,
              discountAmount: lineDiscounts[index]?.discountAmount || 0,
            }))
          }

          const discountAmount = Number(data.discountAmount ?? originalDoc?.discountAmount) || 0
          const afterDiscount = subtotal - discountAmount
          const deliveryCost = Number(data.deliveryCost ?? originalDoc?.deliveryCost) || 0
          data.total = afterDiscount + deliveryCost

          // Auto-populate VAT from global settings on create
          if (operation === "create" && (!data.vatRate || data.vatRate === "none")) {
            try {
              const settings = await req.payload.findGlobal({ slug: "site-settings" })
              const globalVat = Number((settings as { vatPercent?: number | string }).vatPercent) || 0
              if (globalVat > 0) {
                data.vatRate = "custom"
                data.vatCustomRate = globalVat
              }
            } catch {
              // Settings not available yet
            }
          }

          // Calculate VAT amount
          const rateStr = data.vatRate || "none"
          if (rateStr !== "none") {
            const vp = rateStr === "custom"
              ? (Number(data.vatCustomRate) || 0)
              : Number(rateStr)
            data.vatAmount = Math.round(data.total * vp / (100 + vp) * 100) / 100
          } else {
            data.vatAmount = 0
          }
        }

        return data
      },
    ],
    afterChange: [
      async ({ doc, previousDoc, req }) => {
        if (previousDoc && doc.status !== previousDoc.status) {
          console.log(`[Order ${doc.orderId}] Status: ${previousDoc.status} → ${doc.status}`)
        }

        const nextCdekTrackingNumber = String(doc.cdekTrackingNumber || "").trim()
        const previousCdekTrackingNumber = String(previousDoc?.cdekTrackingNumber || "").trim()
        if (
          doc.deliveryMethod === "cdek"
          && nextCdekTrackingNumber
          && nextCdekTrackingNumber !== previousCdekTrackingNumber
        ) {
          const trackingEmail = await sendCdekTrackingEmail(req.payload, doc)
          if (!trackingEmail.sent) {
            console.error(
              `[Order ${doc.orderId || doc.id}] Не удалось отправить трек-номер СДЭК:`,
              trackingEmail.error,
            )
          }
        }

        const runLoyaltySideEffect = async (label: string, task: () => Promise<unknown>) => {
          try {
            await task()
          } catch (error) {
            // Saving an order is the primary operation. Loyalty reconciliation
            // is retryable and must not turn a successfully persisted status
            // change into a generic 500 response in Payload admin or checkout.
            console.error(
              `[Order ${doc.orderId || doc.id}] ${label}:`,
              error instanceof Error ? error.message : error,
            )
          }
        }

        if (doc.status === "delivered") {
          await runLoyaltySideEffect(
            "Не удалось начислить баллы",
            () => accrueLoyaltyForDeliveredOrder(req.payload, doc as Record<string, unknown>),
          )
        }
        if (["cancelled", "returned"].includes(doc.status) || ["cancelled", "failed", "refunded"].includes(doc.paymentStatus)) {
          await runLoyaltySideEffect(
            "Не удалось освободить резерв баллов",
            () => releaseLoyaltyReservation(req.payload, doc.id),
          )
        }
        if (["cancelled", "returned"].includes(doc.status) || doc.paymentStatus === "refunded") {
          await runLoyaltySideEffect(
            "Не удалось выполнить возврат баллов",
            () => reverseLoyaltyForReturnedOrder(req.payload, doc as Record<string, unknown>),
          )
        }
      },
    ],
  },
  fields: [
    // === Sidebar (always visible) ===
    {
      name: "salesChannel",
      type: "select",
      label: "Контур продаж",
      required: true,
      defaultValue: "wholesale",
      index: true,
      options: [
        { label: "Опт", value: "wholesale" },
        { label: "Розница", value: "retail" },
      ],
      admin: {
        position: "sidebar",
        description: "Определяет рабочее пространство, аналитику и политику синхронизации с МойСклад.",
      },
    },
    {
      name: "customerType",
      type: "select",
      label: "Тип покупателя",
      required: true,
      defaultValue: "business",
      options: [
        { label: "Физическое лицо", value: "individual" },
        { label: "Юридическое лицо / оптовик", value: "business" },
      ],
      admin: { position: "sidebar" },
    },
    {
      name: "checkoutMode",
      type: "select",
      label: "Оформление",
      required: true,
      defaultValue: "account",
      options: [
        { label: "Через личный кабинет", value: "account" },
        { label: "Гостевой заказ", value: "guest" },
      ],
      admin: { position: "sidebar" },
    },
    {
      name: "paymentMethod",
      type: "select",
      label: "Способ оплаты",
      required: true,
      defaultValue: "invoice",
      options: [
        { label: "Счёт для юридического лица", value: "invoice" },
        { label: "Онлайн-оплата YooKassa", value: "yookassa" },
        { label: "Сбер (архив)", value: "sber_online" },
      ],
      admin: { position: "sidebar" },
    },
    {
      name: "paymentStatus",
      type: "select",
      label: "Статус оплаты",
      required: true,
      defaultValue: "pending",
      options: [
        { label: "Ожидает оплаты", value: "pending" },
        { label: "Счёт выставлен", value: "invoiced" },
        { label: "Частично оплачен", value: "partial" },
        { label: "Оплачен", value: "paid" },
        { label: "Возврат", value: "refunded" },
        { label: "Отменён", value: "cancelled" },
        { label: "Ошибка оплаты", value: "failed" },
      ],
      admin: { position: "sidebar" },
    },
    {
      name: "paymentExternalId",
      type: "text",
      label: "ID платежа",
      admin: { position: "sidebar", readOnly: true },
    },
    {
      name: "paymentUrl",
      type: "text",
      label: "Ссылка на оплату",
      admin: { position: "sidebar", readOnly: true },
    },
    {
      name: "paymentUpdatedAt",
      type: "date",
      label: "Платёж обновлён",
      admin: { position: "sidebar", readOnly: true },
    },
    {
      name: "cartOwnerId",
      type: "text",
      label: "Владелец корзины",
      admin: { hidden: true },
    },
    {
      name: "cartClearedAt",
      type: "date",
      label: "Корзина очищена",
      admin: { position: "sidebar", readOnly: true },
    },
    {
      name: "subtotal",
      type: "number",
      label: "Сумма товаров",
      required: true,
      admin: {
        position: "sidebar",
        description: "Автоматически суммируется из позиций заказа (можно скорректировать вручную).",
        components: {
          Field: "/payload/components/OrderSubtotalField",
        },
      },
    },
    {
      name: "discountPercent",
      type: "number",
      label: "Скидка (%)",
      defaultValue: 0,
      min: 0,
      max: 100,
      admin: { position: "sidebar", description: "Процент скидки от суммы товаров" },
    },
    {
      name: "discountAmount",
      type: "number",
      label: "Сумма скидки",
      defaultValue: 0,
      admin: { position: "sidebar", readOnly: true, description: "Рассчитывается автоматически" },
    },
    {
      name: "loyaltyPointsRedeemed",
      type: "number",
      label: "Списано баллов",
      defaultValue: 0,
      min: 0,
      admin: { position: "sidebar", readOnly: true, description: "Баллы можно списать только с товаров категории «Кофе»." },
    },
    {
      name: "deliveryCost",
      type: "number",
      label: "Стоимость доставки",
      defaultValue: 0,
      admin: { position: "sidebar" },
    },
    {
      name: "vatRate",
      type: "select",
      label: "Ставка НДС",
      defaultValue: "none",
      options: [
        { label: "Без НДС", value: "none" },
        { label: "0%", value: "0" },
        { label: "5%", value: "5" },
        { label: "10%", value: "10" },
        { label: "20%", value: "20" },
        { label: "22%", value: "22" },
        { label: "Своё значение", value: "custom" },
      ],
      admin: { position: "sidebar" },
    },
    {
      name: "vatCustomRate",
      type: "number",
      label: "НДС (%)",
      min: 0,
      max: 100,
      admin: {
        position: "sidebar",
        condition: (data) => data?.vatRate === "custom",
      },
    },
    {
      name: "vatAmount",
      type: "number",
      label: "Сумма НДС",
      defaultValue: 0,
      admin: { position: "sidebar", readOnly: true, description: "Рассчитывается автоматически" },
    },
    {
      name: "total",
      type: "number",
      label: "ИТОГО",
      required: true,
      admin: { position: "sidebar", readOnly: true, description: "Рассчитывается автоматически" },
    },
    {
      name: "totalWeightGrams",
      type: "number",
      label: "Вес (г)",
      admin: { position: "sidebar" },
    },
    {
      name: "moyskladLinkRepair",
      type: "ui",
      admin: { components: { Field: "/payload/components/MoyskladOrderLinkRepair" }, position: "sidebar" },
    },
    {
      name: "moyskladSyncStatus",
      type: "select",
      label: "МойСклад",
      defaultValue: "disabled",
      options: [
        { label: "Ожидает", value: "pending" },
        { label: "Синхронизирован", value: "synced" },
        { label: "Ошибка", value: "error" },
        { label: "Отключено", value: "disabled" },
      ],
      admin: {
        position: "sidebar",
      },
    },
    {
      name: "moyskladCounterpartyId",
      type: "text",
      label: "ID контрагента в МойСклад",
      admin: {
        position: "sidebar",
        readOnly: true,
      },
    },
    {
      name: "moyskladCustomerOrderId",
      type: "text",
      label: "ID заказа в МойСклад",
      admin: {
        position: "sidebar",
        readOnly: true,
      },
    },
    {
      name: "moyskladInvoiceOutId",
      type: "text",
      label: "ID счёта в МойСклад",
      admin: {
        position: "sidebar",
        readOnly: true,
      },
    },
    {
      name: "moyskladStockLossId",
      type: "text",
      label: "ID технического списания в МойСклад",
      admin: {
        position: "sidebar",
        readOnly: true,
      },
    },
    {
      name: "moyskladStockLossSyncedAt",
      type: "date",
      label: "Списание создано",
      admin: {
        position: "sidebar",
        readOnly: true,
      },
    },
    {
      name: "moyskladStockLossError",
      type: "textarea",
      label: "Ошибка списания МойСклад",
      admin: {
        position: "sidebar",
        readOnly: true,
      },
    },
    {
      name: "moyskladSyncedAt",
      type: "date",
      label: "Синхронизирован",
      admin: {
        position: "sidebar",
        readOnly: true,
      },
    },
    {
      name: "moyskladSyncError",
      type: "textarea",
      label: "Ошибка МойСклад",
      admin: {
        position: "sidebar",
        readOnly: true,
      },
    },
    {
      name: "moyskladSyncedHash",
      type: "text",
      label: "Хэш выгрузки",
      admin: {
        position: "sidebar",
        readOnly: true,
        hidden: true,
        description: "Служебное поле: хэш состава заказа на момент успешной выгрузки в МойСклад.",
      },
    },
    {
      name: "coffeeskladSyncStatus",
      type: "select",
      label: "КофеСклад",
      defaultValue: "disabled",
      options: [
        { label: "Ожидает", value: "pending" },
        { label: "Синхронизирован", value: "synced" },
        { label: "Ошибка", value: "error" },
        { label: "Отключено", value: "disabled" },
      ],
      admin: { position: "sidebar" },
    },
    {
      name: "coffeeskladOrderNumber",
      type: "text",
      label: "Номер заказа в КофеСклад",
      admin: { position: "sidebar", readOnly: true },
    },
    {
      name: "coffeeskladSyncedAt",
      type: "date",
      label: "Выгружен в КофеСклад",
      admin: { position: "sidebar", readOnly: true },
    },
    {
      name: "coffeeskladSyncError",
      type: "textarea",
      label: "Ошибка КофеСклад",
      admin: { position: "sidebar", readOnly: true },
    },

    // === Main content (tabs) ===
    {
      type: "tabs",
      tabs: [
        {
          label: "Основное",
          fields: [
            {
              type: "row",
              fields: [
                {
                  name: "orderId",
                  type: "text",
                  label: "ID заказа",
                  unique: true,
                  admin: {
                    readOnly: true,
                    description: "Генерируется автоматически",
                    width: "33%",
                  },
                },
                {
                  name: "status",
                  type: "select",
                  label: "Статус заказа",
                  required: true,
                  defaultValue: "new",
                  options: [
                    { label: "Новый", value: "new" },
                    { label: "Подтверждён", value: "confirmed" },
                    { label: "Счёт выставлен", value: "invoiced" },
                    { label: "Оплачен", value: "paid" },
                    { label: "В производстве", value: "in_production" },
                    { label: "Собран", value: "ready" },
                    { label: "Отгружен", value: "shipped" },
                    { label: "Доставлен", value: "delivered" },
                    { label: "Возврат", value: "returned" },
                    { label: "Отменён", value: "cancelled" },
                  ],
                  admin: { width: "33%" },
                },
                {
                  name: "client",
                  type: "relationship",
                  label: "Клиент",
                  relationTo: "clients",
                  admin: { width: "34%" },
                },
              ],
            },
            {
              type: "collapsible",
              label: "Контакты покупателя",
              admin: { initCollapsed: false },
              fields: [
                {
                  type: "row",
                  fields: [
                    { name: "customerFullName", type: "text", label: "ФИО", admin: { width: "34%" } },
                    { name: "customerEmail", type: "email", label: "Email", admin: { width: "33%" } },
                    { name: "customerPhone", type: "text", label: "Телефон", admin: { width: "33%" } },
                  ],
                },
              ],
            },
            {
              name: "clientCompanyPicker",
              type: "ui",
              admin: {
                condition: (data) => data?.customerType !== "individual",
                components: {
                  Field: "/payload/components/OrderClientCompanyField",
                },
              },
            },
            {
              type: "row",
              fields: [
                {
                  name: "companyName",
                  type: "text",
                  label: "Компания",
                  admin: { width: "50%", condition: (data) => data?.customerType !== "individual" },
                },
                {
                  name: "companyInn",
                  type: "text",
                  label: "ИНН",
                  admin: { width: "50%", condition: (data) => data?.customerType !== "individual" },
                },
              ],
            },
            {
              type: "collapsible",
              label: "Доставка",
              admin: { initCollapsed: false },
              fields: [
                {
                  type: "row",
                  fields: [
                    {
                      name: "deliveryMethod",
                      type: "select",
                      label: "Способ доставки",
                      required: true,
                      options: [
                        { label: "Самовывоз", value: "self_pickup" },
                        { label: "СДЭК", value: "cdek" },
                        { label: "ЦАП 2000", value: "cap_2000" },
                        { label: "Доставка по Сочи", value: "sochi_delivery" },
                        { label: "Яндекс Доставка", value: "yandex_delivery" },
                      ],
                      admin: { width: "40%" },
                    },
                    {
                      name: "deliveryAddress",
                      type: "text",
                      label: "Адрес доставки",
                      admin: { width: "60%" },
                    },
                  ],
                },
                {
                  name: "cdekTrackingNumber",
                  type: "text",
                  label: "Трек-номер СДЭК",
                  admin: {
                    condition: (data) => data?.deliveryMethod === "cdek",
                  },
                },
                {
                  name: "cap2000TrackingNumber",
                  type: "text",
                  label: "Трек-номер ЦАП-2000",
                  admin: {
                    condition: (data) => data?.deliveryMethod === "cap_2000",
                  },
                },
                {
                  name: "yandexDeliveryType",
                  type: "select",
                  label: "Получение Яндекс Доставки",
                  options: [
                    { label: "Пункт выдачи", value: "pickup_point" },
                    { label: "Постамат", value: "terminal" },
                    { label: "Курьер до двери", value: "courier" },
                  ],
                  admin: { condition: (data) => data?.deliveryMethod === "yandex_delivery" },
                },
                {
                  name: "yandexPickupPointId",
                  type: "text",
                  label: "ID пункта Яндекс Доставки",
                  admin: { readOnly: true, condition: (data) => data?.deliveryMethod === "yandex_delivery" },
                },
                {
                  name: "yandexPickupPointName",
                  type: "text",
                  label: "Пункт Яндекс Доставки",
                  admin: { readOnly: true, condition: (data) => data?.deliveryMethod === "yandex_delivery" },
                },
                {
                  name: "yandexRequestId",
                  type: "text",
                  label: "Номер заявки Яндекс Доставки",
                  admin: { readOnly: true, condition: (data) => data?.deliveryMethod === "yandex_delivery" },
                },
                {
                  name: "yandexDeliveryStatus",
                  type: "text",
                  label: "Статус Яндекс Доставки",
                  admin: { readOnly: true, condition: (data) => data?.deliveryMethod === "yandex_delivery" },
                },
              ],
            },
          ],
        },
        {
          label: "Позиции заказа",
          fields: [
            {
              name: "items",
              type: "array",
              label: "Позиции",
              labels: { singular: "Позиция", plural: "Позиции" },
              fields: [
                {
                  name: "itemProductPicker",
                  type: "ui",
                  admin: {
                    components: {
                      Field: "/payload/components/OrderItemProductPicker",
                    },
                  },
                },
                {
                  type: "row",
                  fields: [
                    { name: "productId", type: "text", admin: { hidden: true } },
                    { name: "cartItemId", type: "text", admin: { hidden: true } },
                    { name: "productName", type: "text", label: "Товар", required: true, admin: { width: "40%" } },
                    { name: "variantName", type: "text", label: "Фасовка", required: true, admin: { width: "30%" } },
                    { name: "grindOption", type: "text", label: "Помол", admin: { width: "30%" } },
                  ],
                },
                {
                  type: "row",
                  admin: { hidden: true },
                  fields: [
                    { name: "shippingLengthCm", type: "number", admin: { hidden: true } },
                    { name: "shippingWidthCm", type: "number", admin: { hidden: true } },
                    { name: "shippingHeightCm", type: "number", admin: { hidden: true } },
                    { name: "shippingWeightGrams", type: "number", admin: { hidden: true } },
                  ],
                },
                {
                  type: "row",
                  fields: [
                    { name: "quantity", type: "number", label: "Кол-во", required: true, admin: { width: "33%" } },
                    { name: "unitPrice", type: "number", label: "Цена/шт", required: true, admin: { width: "33%" } },
                    { name: "totalPrice", type: "number", label: "Сумма", required: true, admin: { width: "34%" } },
                  ],
                },
                {
                  type: "row",
                  fields: [
                    { name: "discountPercent", type: "number", label: "Скидка на позицию (%)", defaultValue: 0, admin: { width: "50%", readOnly: true } },
                    { name: "discountAmount", type: "number", label: "Скидка на позицию", defaultValue: 0, admin: { width: "50%", readOnly: true } },
                  ],
                },
                {
                  type: "row",
                  fields: [
                    {
                      name: "stockProductMoyskladId",
                      type: "text",
                      label: "ID товара для списания",
                      admin: { readOnly: true, hidden: true },
                    },
                    {
                      name: "stockQuantityKg",
                      type: "number",
                      label: "Списание, кг",
                      admin: { readOnly: true, hidden: true },
                    },
                    {
                      name: "stockPricePerKg",
                      type: "number",
                      label: "Цена/кг для списания",
                      admin: { readOnly: true, hidden: true },
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          label: "Промокод и заметки",
          fields: [
            {
              name: "promoCode",
              type: "relationship",
              label: "Промокод",
              relationTo: "promo-codes",
            },
            {
              name: "comment",
              type: "textarea",
              label: "Комментарий клиента",
              admin: {
                readOnly: true,
                description: "Оставлен клиентом при оформлении заказа",
              },
            },
            {
              name: "adminNotes",
              type: "textarea",
              label: "Заметки менеджера",
              admin: {
                description: "Видны только в админ-панели",
              },
            },
          ],
        },
      ],
    },
  ],
  access: {
    read: ordersReadAccess,
    create: operationsCreateAccess,
    update: operationsUpdateAccess,
    delete: operationsDeleteAccess,
  },
}
