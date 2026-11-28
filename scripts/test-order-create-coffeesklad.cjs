/* eslint-disable @typescript-eslint/no-require-imports -- Node test runner */
// Real Payload order afterChange hook; integrations and database are isolated.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

function loadAfterChange(syncOrderToCoffeeskladById) {
  const errors = []
  const mocks = {
    '@/lib/order-line-discounts': { calculateOrderLineDiscounts: () => [] },
    '@/lib/db': { dbQuery: async () => ({ rows: [] }) },
    '@/lib/moysklad/config': { getMoyskladConfig: () => ({}) },
    '@/lib/moysklad/order-retry': { retryFailedMoyskladOrders: async () => ({}) },
    '@/lib/moysklad/order-link-endpoint': { handleOrderLinkRepair: async () => ({}) },
    '../access/adminRoles': {
      canReadOperations: () => true,
      canRunIntegrations: () => true,
      getAllowedSalesChannels: () => ['wholesale', 'retail'],
      operationsCreateAccess: () => true,
      operationsDeleteAccess: () => true,
      operationsUpdateAccess: () => true,
    },
    '../admin/workspace': { orderWorkspaceBaseFilter: () => ({}) },
    '@/lib/loyalty': {
      accrueLoyaltyForDeliveredOrder: async () => ({}),
      releaseLoyaltyReservation: async () => ({}),
      reverseLoyaltyForReturnedOrder: async () => ({}),
    },
    '@/lib/cdek-tracking-email': { sendCdekTrackingEmail: async () => ({ sent: true }) },
    '@/lib/coffeesklad/cancel': { cancelOrderInCoffeesklad: async () => ({ success: true }) },
    '@/lib/coffeesklad/sync': { syncOrderToCoffeeskladById },
  }
  const filename = 'payload/collections/Orders.ts'
  const source = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, '..', filename), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const mod = { exports: {} }
  const localRequire = id => {
    if (Object.hasOwn(mocks, id)) return mocks[id]
    throw new Error(`Unexpected dependency: ${id}`)
  }
  const testConsole = {
    log() {},
    warn() {},
    error(...args) { errors.push(args) },
  }
  vm.runInNewContext(`(function(require,module,exports){${source}\n})`, {
    console: testConsole, Buffer, URL, URLSearchParams, process, Intl, Date, Math, Number, String,
    Boolean, Array, Object, Set, Map, Promise, Error, JSON, Response, ReadableStream, TextEncoder,
  }, { filename })(localRequire, mod, mod.exports)
  return { afterChange: mod.exports.Orders.hooks.afterChange[0], errors }
}

function order(overrides = {}) {
  return {
    id: 456,
    orderId: 'TEST-ADMIN-CREATE',
    salesChannel: 'wholesale',
    paymentStatus: 'pending',
    status: 'new',
    ...overrides,
  }
}

async function runHook({ doc = order(), operation = 'create', context = {}, sync } = {}) {
  const calls = []
  const { afterChange, errors } = loadAfterChange(async (payload, id) => {
    calls.push({ payload, id })
    return sync ? sync() : { success: true }
  })
  const payload = { id: 'payload' }
  await afterChange({ doc, previousDoc: undefined, operation, req: { payload, context } })
  return { calls, errors, payload }
}

test('admin-created wholesale order is exported to Coffeesklad once', async () => {
  const { calls, payload } = await runHook()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].payload, payload)
  assert.equal(calls[0].id, 456)
})

test('existing wholesale checkout context prevents duplicate Coffeesklad export', async () => {
  const { calls } = await runHook({ context: { coffeeskladCreateSync: true } })
  assert.equal(calls.length, 0)
})

test('pending retail order waits for confirmed payment before Coffeesklad export', async () => {
  const { calls } = await runHook({ doc: order({ salesChannel: 'retail', paymentStatus: 'pending' }) })
  assert.equal(calls.length, 0)
})

test('paid retail order created in admin is exported to Coffeesklad once', async () => {
  const { calls } = await runHook({ doc: order({ salesChannel: 'retail', paymentStatus: 'paid', status: 'paid' }) })
  assert.equal(calls.length, 1)
})

test('Coffeesklad failure does not reject an already saved order', async () => {
  const { calls, errors } = await runHook({ sync: () => { throw new Error('Coffeesklad unavailable') } })
  assert.equal(calls.length, 1)
  assert.ok(errors.some(args => args.some(value => String(value).includes('Coffeesklad unavailable'))))
})

test('editing an existing order does not repeat create-time Coffeesklad export', async () => {
  const { afterChange } = loadAfterChange(async () => {
    throw new Error('Update must not trigger create-time Coffeesklad export')
  })
  await afterChange({
    doc: order(),
    previousDoc: order({ customerFullName: 'Before edit' }),
    operation: 'update',
    req: { payload: {}, context: {} },
  })
})
