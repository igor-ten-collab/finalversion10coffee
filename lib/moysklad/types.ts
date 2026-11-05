export type MoyskladEntityType =
  | "organization"
  | "store"
  | "counterparty"
  | "customerorder"
  | "invoiceout"
  | "loss"
  | "product"
  | "variant"
  | "bundle"
  | "service"
  | "productfolder"
  | "state"
  | "saleschannel"
  | "project"
  | "contract"
  | "uom"

export interface MoyskladMeta {
  href: string
  type: MoyskladEntityType | string
  mediaType: "application/json"
}

export interface MoyskladEntity {
  id?: string
  name?: string
  meta?: MoyskladMeta
}

export interface MoyskladListResponse<T> {
  context?: unknown
  meta: {
    href: string
    type: string
    mediaType: string
    size: number
    limit: number
    offset: number
  }
  rows: T[]
}

export interface MoyskladCounterparty extends MoyskladEntity {
  email?: string
  phone?: string
  inn?: string
  kpp?: string
}

export interface MoyskladProductFolder extends MoyskladEntity {
  archived?: boolean
  pathName?: string
}

export interface MoyskladAssortment extends MoyskladEntity {
  code?: string
  article?: string
  description?: string
  archived?: boolean
  salePrices?: {
    value?: number
    priceType?: {
      id?: string
      name?: string
    }
  }[]
  stock?: number
  productFolder?: MoyskladEntity
  product?: MoyskladEntity
}

export interface MoyskladProduct extends MoyskladAssortment {
  productFolder?: MoyskladEntity
}

export interface MoyskladVariant extends MoyskladAssortment {
  product?: MoyskladEntity
}

export interface MoyskladCustomerOrder extends MoyskladEntity {
  organization?: MoyskladEntity
  agent?: MoyskladEntity
  externalCode?: string
  moment?: string
  sum?: number
  payedSum?: number
  shippedSum?: number
  invoicedSum?: number
  state?: MoyskladEntity
}

export interface MoyskladInvoiceOut extends MoyskladEntity {
  organization?: MoyskladEntity
  agent?: MoyskladEntity
  customerOrder?: MoyskladEntity
  externalCode?: string
  moment?: string
  sum?: number
}

export interface MoyskladLoss extends MoyskladEntity {
  externalCode?: string
  moment?: string
  sum?: number
}

export interface MoyskladSalesChannel extends MoyskladEntity {
  type?: "ECOMMERCE" | "RETAIL_SALES" | string
}

export interface MoyskladOrderPositionPayload {
  quantity: number
  price: number
  discount?: number
  vat?: number
  pack?: {
    id: string
  }
  assortment: {
    meta: MoyskladMeta
  }
}
