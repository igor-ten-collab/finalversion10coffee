import test from "node:test"
import assert from "node:assert/strict"
import type { Payload } from "payload"
import { syncOrderToCoffeeskladById } from "../lib/coffeesklad/sync"

interface WebhookItem {
  qty: number
  price: number
  base_price: number
  discount_pct: number
}

interface WebhookBody {
  order_created?: string
  items: WebhookItem[]
}

const order570 = {
  id: 429,
  orderId: "10C-00570",
  createdAt: "2026-11-13T07:31:34.453Z",
  salesChannel: "wholesale",
  customerType: "business",
  companyName: "Тестовый покупатель",
  status: "new",
  items: [
    {
      productId: 1,
      productName: "Espresso Colombia",
      variantName: "1 кг, В зернах",
      grindOption: "В зёрнах",
      quantity: 6,
      unitPrice: 2699,
      totalPrice: 16194,
      discountPercent: 30,
      discountAmount: 4858,
    },
    {
      productId: 2,
      productName: "Матча Премиум 250г.",
      variantName: "1 шт",
      quantity: 1,
      unitPrice: 765,
      totalPrice: 765,
      discountPercent: 10,
      discountAmount: 77,
    },
  ],
}

const products = [
  { id: 1, name: "Espresso Colombia", variants: [{ name: "1 кг, В зернах", sku: "TEST-COL-1KG" }] },
  { id: 2, name: "Матча Премиум 250г.", variants: [{ name: "1 шт", sku: "TEST-MATCHA-250" }] },
]

test("site order export preserves timestamp, line discounts and exact kopecks", async () => {
  process.env.COFFESKLAD_ENABLED = "true"
  process.env.COFFESKLAD_URL = "http://127.0.0.1:65534"
  process.env.COFFESKLAD_API_KEY = "local-test-key"

  let body: WebhookBody | undefined
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body)) as WebhookBody
    return new Response(JSON.stringify({ id: 999, number: "10C-00570" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }

  const payload = {
    findByID: async () => order570,
    find: async () => ({ docs: products }),
    findGlobal: async () => ({ vatPercent: 22 }),
    update: async () => ({}),
  }

  try {
    const result = await syncOrderToCoffeeskladById(payload as unknown as Payload, 429)
    assert.equal(result.success, true)
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.ok(body)
  assert.equal(body.order_created, order570.createdAt)
  assert.deepEqual(
    body.items.map((item) => ({
      base_price: item.base_price,
      discount_pct: item.discount_pct,
    })),
    [
      { base_price: 2699, discount_pct: 30 },
      { base_price: 765, discount_pct: 10 },
    ],
  )
  const exportedTotal = body.items.reduce((sum, item) => sum + item.qty * item.price, 0)
  assert.equal(Math.round(exportedTotal * 100) / 100, 12024)
})
