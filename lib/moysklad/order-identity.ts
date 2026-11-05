import { extractMoyskladId } from "./client"
import type { MoyskladCustomerOrder, MoyskladInvoiceOut } from "./types"

export interface OrderIdentity {
  id: string | number
  orderId?: string
}

export function orderExternalCode(order: OrderIdentity): string {
  const number = order.orderId?.trim()
  if (!number || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(number)) {
    throw new Error("Нет корректного полного номера заказа; выгрузка остановлена")
  }
  // Database IDs can be reused after restoring a backup. The visible order
  // number is allocated independently and is the durable integration key.
  return `10coffee-order-${number}`
}

export function assertRemoteOrderIdentity(
  remote: MoyskladCustomerOrder,
  order: OrderIdentity,
  organizationId: string | undefined,
  counterpartyId?: string | null,
) {
  orderExternalCode(order)
  const label = `Заказ ${order.orderId}: документ МойСклад ${remote.id || "без ID"}`
  if (!remote.id || remote.name !== order.orderId) {
    throw new Error(`${label} имеет другой номер (${remote.name || "не указан"}). Изменение чужого документа запрещено`)
  }
  if (!organizationId || extractMoyskladId(remote.organization) !== organizationId) {
    throw new Error(`${label}: организация не совпадает. Выгрузка остановлена`)
  }
  if (counterpartyId && extractMoyskladId(remote.agent) !== counterpartyId) {
    throw new Error(`${label}: контрагент не совпадает. Изменение чужого документа запрещено`)
  }
}

export function assertRemoteInvoiceIdentity(
  remote: MoyskladInvoiceOut,
  orderNumber: string,
  customerOrderId: string,
  organizationId: string | undefined,
  counterpartyId: string,
) {
  if (!remote.id || extractMoyskladId(remote.customerOrder) !== customerOrderId
    || !organizationId || extractMoyskladId(remote.organization) !== organizationId
    || extractMoyskladId(remote.agent) !== counterpartyId) {
    throw new Error(`Счёт к заказу ${orderNumber}: связь с заказом, организация или контрагент не совпадают. Изменение чужого документа запрещено`)
  }
}

export function assertRemoteOrderTotalsConsistent(remote: MoyskladCustomerOrder) {
  const sum = Number(remote.sum)
  // A document already overwritten with a smaller/new order can still carry
  // the old invoice/shipment/payment aggregates. Do not import its status or
  // overwrite it again while its financial links need investigation.
  if (Number.isFinite(sum) && [remote.invoicedSum, remote.shippedSum, remote.payedSum]
    .some(value => value !== undefined && Number(value) > sum + 1)) {
    throw new Error(`Заказ ${remote.name}: суммы связанных счетов, отгрузок или оплат превышают сумму заказа. Требуется сверка документов МойСклад`)
  }
}
