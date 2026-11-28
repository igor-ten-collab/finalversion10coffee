/* eslint-disable @typescript-eslint/no-require-imports -- Node test runner */
// Real wholesale server action; external services are isolated, no live orders.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

test('Coffeesklad export runs immediately after order creation even if Moysklad fails unexpectedly', async () => {
  const events = []
  const order = { id: 999, orderId: 'TEST-WHOLESALE', createdAt: '2026-11-16T12:00:00.000Z' }
  const payload = {
    find: async ({ collection }) => {
      assert.equal(collection, 'clients')
      return { docs: [{ id: 10, fullName: 'Test', email: 'test@example.invalid', discountPercent: 0 }] }
    },
    create: async ({ collection, context }) => {
      assert.equal(collection, 'orders')
      assert.equal(context?.coffeeskladCreateSync, true,
        'The afterChange hook must leave this existing direct export to the checkout action')
      events.push('create')
      return order
    },
  }
  const company = {
    id: 'company', name: 'Test company', inn: '1234567890',
    legal_address: 'Test address', actual_address: null,
  }
  const adminDb = {
    from(table) {
      if (table === 'companies') {
        const query = {
          select() { return query },
          eq() { return query },
          maybeSingle: async () => ({ data: company }),
        }
        return query
      }
      if (table === 'order_items') return { insert: async () => ({ error: null }) }
      throw new Error(`Unexpected table before Moysklad failure: ${table}`)
    },
  }
  const mocks = {
    payload: { getPayload: async () => payload },
    '@payload-config': { default: {} },
    '@/lib/auth/payload-admin': { requirePayloadAdmin: async () => ({}) },
    '@/lib/supabase/server': { createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'user', email: 'test@example.invalid' } } }) } }) },
    '@/lib/supabase/admin': { createAdminClient: () => adminDb },
    '@/lib/actions/cart': {
      getCartItems: async () => [{ id: 'line', product_id: 'product', variant_id: 'variant', quantity: 2,
        product: { id: 'product', name: 'Coffee' }, variant: { id: 'variant', name: '1 кг', price: 1000, weight_grams: 1000 } }],
      clearCart: async () => ({ success: true }),
      addToCart: async () => ({ success: true }),
    },
    '@/lib/discounts': {
      calculateClientDiscount: () => ({ amount: 0, lines: [], hasBaseDiscount: false, hasCategoryDiscount: false, hasProductDiscount: false }),
      normalizeCategoryDiscounts: value => value,
      normalizeDiscountPercent: value => Number(value) || 0,
      normalizeProductDiscounts: value => value,
    },
    '@/lib/product-types': { getRelationshipId: value => typeof value === 'object' && value !== null ? value.id : value ?? null },
    'next/cache': { revalidatePath() {} },
    '@/lib/email/smtp': { createSmtpTransport: () => ({ sendMail: async () => ({}) }) },
    '@/lib/moysklad/sync': {
      buildMoyskladStockLossLines: () => [],
      syncOrderToMoysklad: async () => { events.push('moysklad'); throw new Error('Unexpected Moysklad failure') },
    },
    '@/lib/coffeesklad/sync': {
      syncOrderToCoffeeskladById: async (_payload, id) => {
        assert.equal(id, order.id)
        events.push('coffeesklad')
        return { success: true, orderNumber: order.orderId }
      },
    },
    '@/lib/cdek': { calculateTariff: async () => [] },
    '@/lib/delivery-packaging': {
      calculateDeliveryPackaging: () => ({ packages: [], packagingCost: 0 }),
      getDeliveryPackagingSettings: async () => ({}),
      shippingLinesFromCartItems: () => [],
    },
  }
  const filename = 'lib/actions/orders.ts'
  const source = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '..', filename), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const mod = { exports: {} }
  const localRequire = id => {
    if (Object.hasOwn(mocks, id)) return mocks[id]
    throw new Error(`Unexpected dependency: ${id}`)
  }
  vm.runInNewContext(`(function(require,module,exports){${source}\n})`, {
    console, Buffer, URL, URLSearchParams, process, Intl, Date, Math, Number, String, Boolean, Array, Object, Set, Map, Promise, Error, JSON,
  }, { filename })(localRequire, mod, mod.exports)

  await assert.rejects(
    () => mod.exports.createOrder({ companyId: 'company', deliveryMethod: 'self_pickup' }),
    /Unexpected Moysklad failure/,
  )
  assert.deepEqual(events, ['create', 'coffeesklad', 'moysklad'],
    'Coffeesklad must not depend on later Moysklad, email or notification steps')
})
