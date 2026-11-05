/* eslint-disable @typescript-eslint/no-require-imports -- Node test runner */
// Real integration modules, isolated HTTP/database adapters; no live orders.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const root = path.resolve(__dirname, '..')
const compiled = new Map()

function fixture({ respond, config: overrides = {}, signalAPI = AbortSignal, onDelay, dbConnection, extraMocks = {} } = {}) {
  const calls = [], waits = [], updates = []
  const config = {
    enabled: true, syncOrdersOnCreate: true, authMode: 'bearer', token: 'test-only',
    baseUrl: 'https://moysklad.invalid/api/remap/1.2', organizationId: 'organization',
    storeId: 'store', salesChannelId: 'channel', vatEnabled: false,
    createInvoiceOnOrder: false, ...overrides,
  }
  const payload = {
    update: async (input) => { updates.push(input); return { id: input.id, ...input.data } },
    findByID: async () => ({ id: 382 }),
  }
  const fetchMock = async (url, init) => {
    const requestPath = url.replace(config.baseUrl + '/', '')
    const call = { path: requestPath, method: init.method || 'GET', init }
    calls.push(call)
    const response = await respond?.(call, calls.length)
    if (response) return response
    if (call.method === 'GET' && requestPath.includes('?')) return Response.json({ rows: [] })
    if (call.method === 'GET' && requestPath.startsWith('entity/customerorder/')) return Response.json({
      id: requestPath.split('/').pop(), name: params.order.orderId, externalCode: String(params.order.id),
      organization: { id: config.organizationId }, agent: { id: params.client.moyskladCounterpartyId || 'counterparty' },
    })
    if (call.method === 'GET' && requestPath.startsWith('entity/invoiceout/')) return Response.json({
      id: requestPath.split('/').pop(), externalCode: params.order.orderId + '-invoice',
      organization: { id: config.organizationId }, agent: { id: params.client.moyskladCounterpartyId || 'counterparty' },
      customerOrder: { id: params.order.moyskladCustomerOrderId || 'remote-id' },
    })
    if (requestPath.startsWith('entity/variant/')) return Response.json({ id: 'variant', name: 'Coffee 250g' })
    if (requestPath.startsWith('entity/product/')) return Response.json({ id: 'product' })
    if (call.method === 'POST' || call.method === 'PUT') return Response.json({ id: 'remote-id' })
    throw new Error(`Unexpected HTTP call: ${call.method} ${requestPath}`)
  }
  const modules = new Map()
  const mocks = {
    'lib/moysklad/config': { getMoyskladConfig: () => config, assertMoyskladReady() {} },
    'lib/moysklad/logs': { writeMoyskladLog: async () => {} },
    'lib/supabase/admin': { createAdminClient: () => { throw new Error('Unexpected Supabase access') } },
    'lib/utils/constants': { DELIVERY_METHOD_LABELS: {} },
    'lib/db': { dbQuery: async () => { throw new Error('Unexpected SQL mutation') }, getPool: () => ({ connect: async () => {
      if (!dbConnection) throw new Error('Unexpected database connection')
      return dbConnection
    } }) },
    'node:timers/promises': { setTimeout: async (ms, value, options) => {
      waits.push(ms)
      await onDelay?.()
      options?.signal?.throwIfAborted()
      return value
    } },
    ...extraMocks,
  }
  function load(file) {
    if (modules.has(file)) return modules.get(file).exports
    const loaded = { exports: {} }
    modules.set(file, loaded)
    if (!compiled.has(file)) {
      compiled.set(file, ts.transpileModule(fs.readFileSync(path.join(root, file + '.ts'), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText)
    }
    const localRequire = (id) => {
      const target = id.startsWith('@/') ? id.slice(2) : id.startsWith('.')
        ? path.posix.normalize(path.posix.join(path.posix.dirname(file), id)) : id
      if (Object.hasOwn(mocks, target)) return mocks[target]
      if (['crypto', 'node:crypto'].includes(target)) return require('node:crypto')
      if (target === 'node:util') return require('node:util')
      if (target === 'lib/moysklad/order-identity') return load(target)
      if (target === 'lib/payments/yookassa') return load(target)
      if (['lib/moysklad/status-sync', 'payload/collections/Orders', 'lib/moysklad/client', 'lib/moysklad/sync', 'lib/moysklad/bundles', 'lib/moysklad/order-totals', 'lib/moysklad/order-eligibility', 'lib/moysklad/order-link-repair', 'lib/moysklad/order-hash', 'lib/moysklad/order-link-service', 'lib/moysklad/order-link-endpoint', 'lib/moysklad/order-retry', 'lib/moysklad/import-catalog', 'lib/moysklad/products', 'lib/slug', 'lib/discounts', 'lib/product-types', 'payload/access/adminRoles', 'lib/actions/products', 'lib/actions/shop-orders', 'lib/utils/phone', 'lib/payments/yookassa-receipt', 'lib/payments/yookassa-order-status', 'app/api/shop/payments/yookassa/webhook/route'].includes(target)) return load(target)
      throw new Error(`Unexpected dependency: ${id}`)
    }
    vm.runInNewContext(`(function(require,module,exports){${compiled.get(file)}\n})`, {
      fetch: fetchMock, AbortSignal: signalAPI, Buffer, URLSearchParams, URL, Response,
      TypeError, Error, process: { env: { NODE_ENV: 'test' } }, console: { error() {}, warn() {}, log() {} },
    }, { filename: file })(localRequire, loaded, loaded.exports)
    return loaded.exports
  }
  const client = load('lib/moysklad/client')
  const sync = load('lib/moysklad/sync')
  const params = {
    payload, order: { id: 382, orderId: '10C-00382', customerType: 'business' },
    client: { moyskladCounterpartyId: 'counterparty' },
    cartItems: [{ id: 'line', quantity: 1, product_id: 'local-product', variant_id: 'local-variant',
      product: { name: 'Coffee', moysklad_id: 'product' }, variant: { name: '250g', price: 500 } }],
  }
  return { client, sync, load, params, payload, calls, waits, updates }
}

const unavailable = () => new Response('<html>unavailable</html>', { status: 503 })
const writes = (f, entity) => f.calls.filter(c => c.path === `entity/${entity}` && c.method === 'POST')

function retryFixture(orders, respond) {
  const f = fixture({ respond }), events = []
  f.payload.find = async ({ collection }) => {
    if (collection === 'orders') return { docs: orders, totalPages: 1 }
    if (collection === 'products') return { docs: [{ id: 'product', name: 'Coffee', moyskladId: 'product',
      variants: [{ id: 'variant', name: '250g', moyskladId: 'variant', moyskladType: 'variant', price: 500 }] }] }
    throw new Error(`Unexpected collection: ${collection}`)
  }
  return { ...f, events, run: options => f.load('lib/moysklad/order-retry').retryFailedMoyskladOrders(f.payload, {
    includeAllUnexported: true, includeExisting: true, minAgeMs: 0,
    onProgress: event => events.push(event), ...options,
  }) }
}

const historicalOrder = () => ({ id: 160, orderId: '10C-00179', moyskladSyncStatus: 'error',
  moyskladSyncError: 'conflict 3006', total: 19192, paymentStatus: 'pending', items: [] })
const retryOrder = (id, orderId) => ({ id, orderId, moyskladSyncStatus: 'error', customerType: 'business',
  subtotal: 500, total: 500, client: { moyskladCounterpartyId: 'counterparty' },
  items: [{ id: 'line', productName: 'Coffee', variantName: '250g', unitPrice: 500, quantity: 1 }] })

for (const [label, options] of [
  ['full retry', {}], ['selection', { orderIds: [160] }],
  ['forced selection', { orderIds: [160], forceSelected: true }],
  ['background retry', { includeAllUnexported: false, includeExisting: false }],
]) {
  test(`historical 10C-00179 is explicitly skipped without network or order writes in ${label}`, async () => {
    const order = historicalOrder(), before = structuredClone(order), f = retryFixture([order])
    const result = await f.run(options)
    assert.equal(result.failed, 0)
    assert.equal(result.succeeded, 0)
    assert.equal(result.synced, 0)
    assert.equal(result.skippedTotal, 1)
    assert.equal(result.retryable, 0)
    assert.equal(result.excludedCount, 1)
    assert.equal(JSON.stringify(result).includes('10C-00179'), false)
    assert.equal(result.retried.length, 0)
    assert.equal(f.calls.length, 0)
    assert.equal(f.updates.length, 0)
    assert.deepEqual(order, before)
    assert.equal(JSON.stringify(f.events).includes('10C-00179'), false)
    assert.match(f.events.at(-1).message, /отправлено 0, пропущено 1, ошибок 0/)
  })
}

test('bulk retry skips the exception, still exports another order and counts unchanged orders separately', async () => {
  const excluded = historicalOrder(), pending = retryOrder(161, 'TEST-NEW'), unchanged = retryOrder(162, 'TEST-SYNCED')
  unchanged.moyskladCustomerOrderId = 'synced-remote'
  const f = retryFixture([excluded, pending, unchanged], call => {
    if (call.method === 'GET' && call.path.startsWith('entity/customerorder?')
      && new URLSearchParams(call.path.split('?')[1]).get('filter')?.startsWith('organization=')) {
      return Response.json({ rows: [{ id: 'synced-remote', name: unchanged.orderId, externalCode: String(unchanged.id),
        organization: { id: 'organization' }, agent: { id: 'counterparty' } }] })
    }
    if (call.method === 'POST' && call.path === 'entity/customerorder') return Response.json({ id: 'new-remote', sum: 50000 })
  })
  unchanged.moyskladSyncedHash = f.load('lib/moysklad/order-hash').computeOrderContentHash(unchanged)
  const result = await f.run()
  assert.equal(result.checked, 3)
  assert.equal(result.synced, 1)
  assert.equal(result.succeeded, 1, JSON.stringify(result.retried))
  assert.equal(result.failed, 0)
  assert.equal(result.skippedTotal, 2)
  assert.equal(result.skipped, 1)
  assert.equal(result.excludedCount, 1)
  assert.ok(f.updates.length > 0)
  assert.ok(f.updates.every(u => u.id === pending.id))
  assert.equal(writes(f, 'customerorder').length, 1)
  assert.equal(JSON.parse(writes(f, 'customerorder')[0].init.body).name, 'TEST-NEW')
})

for (const [id, number] of [[161, '10C-00179'], [160, 'TEST-OTHER'], [343, '10C-00376']]) {
  test(`uniqueness error remains a failure for non-excluded identity ${id}/${number}`, async () => {
    const order = retryOrder(id, number), f = retryFixture([order], call => {
      if (call.method === 'POST' && call.path === 'entity/customerorder') {
        return Response.json({ errors: [{ code: 3006, error: 'unique name conflict' }] }, { status: 412 })
      }
    })
    const result = await f.run()
    assert.equal(result.excludedCount, 0)
    assert.equal(result.skippedTotal, 0)
    assert.equal(result.failed, 1)
    assert.match(result.retried[0].error, /3006/)
    assert.ok(f.updates.some(u => u.data.moyskladSyncStatus === 'error'))
  })
}

function repairFixture() {
  const order = { order_id: 'TEST-179', total: 19192, subtotal: 23990, discount_amount: 4798,
    delivery_cost: 0, moysklad_counterparty_id: 'buyer', payment_status: 'pending', status: 'new' }
  const items = [{ product_name: 'Coffee', variant_name: '1 кг, В зёрнах', quantity: 10, unit_price: 2399 }]
  const doc = { id: 'remote-order', name: 'TEST-179', updated: '2026-09-01', sum: 1919200,
    agent: { meta: { href: '/counterparty/buyer' } }, organization: { meta: { href: '/organization/org' } },
    positions: { meta: { size: 1 }, rows: [{ quantity: 10, price: 239900, discount: 20, assortment: { name: 'Coffee (1 кг, В зернах)' } }] } }
  const invoice = structuredClone(doc)
  invoice.id = 'invoice'
  invoice.name = 'invoice-22'
  invoice.customerOrder = { meta: { href: '/customerorder/remote-order' } }
  const expected = { orderNumber: 'TEST-179', total: 19192, counterpartyId: 'buyer', organizationId: 'org' }
  return { order, items, doc, invoice, expected }
}

function repairServiceFixture(fault = '') {
  const clone = value => JSON.parse(JSON.stringify(value))
  const x = repairFixture()
  const ids = {
    order: '11111111-1111-1111-1111-111111111111', invoice: '22222222-2222-2222-2222-222222222222',
    buyer: '33333333-3333-3333-3333-333333333333', org: '44444444-4444-4444-4444-444444444444',
  }
  x.order.id = 160; x.order.sales_channel = 'wholesale'; x.order.moysklad_counterparty_id = ids.buyer
  x.order.moysklad_customer_order_id = null; x.order.moysklad_invoice_out_id = null
  x.doc.id = ids.order; x.invoice.id = ids.invoice
  x.invoice.customerOrder.meta.href = `/customerorder/${ids.order}`
  x.doc.invoicesOut = [{ meta: { href: `/invoiceout/${ids.invoice}` } }]
  for (const d of [x.doc, x.invoice]) {
    d.agent.meta.href = `/counterparty/${ids.buyer}`; d.organization.meta.href = `/organization/${ids.org}`
  }
  let row = clone(x.order), rows = clone(x.items), backup
  const queries = [], logs = [], original = clone(row)
  const dbConnection = { release() {}, async query(sql, values = []) {
    queries.push(sql)
    if (sql.startsWith('BEGIN')) { backup = { row: clone(row), rows: clone(rows), logs: logs.slice() }; return { rows: [] } }
    if (sql.startsWith('SET LOCAL') || sql === 'COMMIT') return { rows: [] }
    if (sql === 'ROLLBACK') { row = backup.row; rows = backup.rows; logs.splice(0, logs.length, ...backup.logs); return { rows: [] } }
    if (sql.startsWith('SELECT to_jsonb')) return { rows: [{ row: clone(row) }] }
    if (sql.startsWith('SELECT * FROM orders_items')) return { rows: clone(rows) }
    if (sql.startsWith('SELECT id FROM orders')) return { rows: fault === 'duplicate' ? [{ id: 999 }] : [] }
    if (sql.startsWith('INSERT INTO')) {
      if (fault === 'audit') throw new Error('audit unavailable')
      logs.push({ previous: JSON.parse(values[3]), plan: JSON.parse(values[4]) })
      return { rows: [] }
    }
    if (sql.startsWith('UPDATE orders SET')) {
      const assignments = sql.split('SET')[1].split('WHERE')[0].split(',')
      for (const assignment of assignments) {
        const match = assignment.trim().match(/^(\w+)\s*=\s*(\$\d+|'[^']*'|NOW\(\))$/)
        assert.ok(match, assignment)
        const [, key, expression] = match
        row[key] = expression.startsWith('$') ? values[Number(expression.slice(1)) - 1]
          : expression === 'NOW()' ? '2026-09-07T14:00:00Z' : expression.slice(1, -1)
      }
      if (fault === 'trigger') row.payment_status = 'paid'
      return { rows: [], rowCount: 1 }
    }
    throw new Error(`Unexpected SQL: ${sql}`)
  } }
  const f = fixture({ dbConnection, config: { organizationId: ids.org }, respond: call => {
    assert.equal(call.method, 'GET', 'recovery must never write to MoySklad')
    if (call.path.startsWith('entity/customerorder?')) return Response.json({ rows: fault === 'ambiguous' ? [{ id: ids.order }, { id: ids.invoice }] : [{ id: ids.order }], meta: { size: fault === 'ambiguous' ? 2 : 1 } })
    const doc = clone(call.path.startsWith('entity/invoiceout/') ? x.invoice : x.doc)
    if (fault === 'remote-change' && queries.some(q => q.startsWith('UPDATE'))) doc.updated = '2026-09-08'
    return Response.json(doc)
  } })
  return { ...f, queries, logs, original, getRow: () => clone(row), changeAddress: () => { row.delivery_address = 'Changed after preview' } }
}

test('admin preview reads only; apply changes only six metadata fields and commits the backup in the same transaction', async () => {
  const f = repairServiceFixture(), service = f.load('lib/moysklad/order-link-service')
  const plan = await service.repairMoyskladOrderLink({ orderId: 160 })
  assert.equal(plan.changed, false)
  assert.deepEqual(f.getRow(), f.original)
  assert.equal(f.queries.some(q => /^(INSERT|UPDATE)/.test(q)), false)
  const result = await service.repairMoyskladOrderLink({ orderId: 160, apply: true, fingerprint: plan.fingerprint, actorId: 7 })
  assert.equal(result.changed, true)
  assert.equal(f.getRow().moysklad_customer_order_id, plan.remoteId)
  assert.equal(f.getRow().moysklad_invoice_out_id, plan.invoiceId)
  assert.equal(f.getRow().payment_status, 'pending')
  const repair = f.load('lib/moysklad/order-link-repair')
  assert.deepEqual(repair.orderWithoutRepairMetadata(f.getRow()), repair.orderWithoutRepairMetadata(f.original))
  assert.equal(f.logs.length, 1)
  assert.equal(f.logs[0].previous.actorId, 7)
  assert.equal(f.logs[0].previous.previous.moysklad_customer_order_id, null)
  assert.equal(f.queries.at(-1), 'COMMIT')
  const again = await service.repairMoyskladOrderLink({ orderId: 160, apply: true, fingerprint: plan.fingerprint })
  assert.equal(again.alreadyLinked, true)
  assert.equal(f.logs.length, 1)
})

for (const fault of ['ambiguous', 'duplicate', 'audit', 'trigger', 'remote-change']) {
  test(`admin link recovery leaves all data unchanged when ${fault} check fails`, async () => {
    const f = repairServiceFixture(fault), service = f.load('lib/moysklad/order-link-service')
    if (['ambiguous', 'duplicate'].includes(fault)) await assert.rejects(service.repairMoyskladOrderLink({ orderId: 160 }))
    else {
      const plan = await service.repairMoyskladOrderLink({ orderId: 160 })
      await assert.rejects(service.repairMoyskladOrderLink({ orderId: 160, apply: true, fingerprint: plan.fingerprint }))
    }
    assert.deepEqual(f.getRow(), f.original)
    assert.equal(f.logs.length, 0)
    assert.equal(f.queries.includes('COMMIT'), false)
    if (['trigger', 'remote-change'].includes(fault)) assert.ok(f.queries.some(q => q.startsWith('UPDATE')))
  })
}

test('stale preview and disallowed workspace cannot apply a link', async () => {
  const f = repairServiceFixture(), service = f.load('lib/moysklad/order-link-service')
  await assert.rejects(service.repairMoyskladOrderLink({ orderId: 160, allowedSalesChannels: ['retail'] }), /Нет доступа/)
  const plan = await service.repairMoyskladOrderLink({ orderId: 160 })
  f.changeAddress()
  await assert.rejects(service.repairMoyskladOrderLink({ orderId: 160, apply: true, fingerprint: plan.fingerprint }), /изменились после проверки/)
  assert.equal(f.queries.some(q => /^(INSERT|UPDATE)/.test(q)), false)
})

test('link endpoint rejects customers, unauthorized staff, cross-site requests and apply without preview', async () => {
  const f = fixture(), endpoint = f.load('lib/moysklad/order-link-endpoint')
  const req = { url: 'https://10coffee.test/api/orders/moysklad/relink', user: { id: 1, collection: 'admins', role: 'admin' },
    headers: new Headers({ 'content-type': 'application/json', origin: 'https://10coffee.test', host: '10coffee.test' }), json: async () => ({ orderId: 160, mode: 'preview' }) }
  for (const user of [null, { collection: 'clients', role: 'admin' }, { collection: 'admins', role: 'support' }]) {
    assert.equal((await endpoint.handleOrderLinkRepair({ ...req, user })).status, 403)
  }
  assert.equal((await endpoint.handleOrderLinkRepair({ ...req, headers: new Headers({ 'content-type': 'application/json', origin: 'https://evil.test', host: '10coffee.test' }) })).status, 403)
  assert.equal((await endpoint.handleOrderLinkRepair({ ...req, json: async () => ({ orderId: 160, mode: 'apply' }) })).status, 400)
  assert.equal((await endpoint.handleOrderLinkRepair({ ...req, json: async () => ({ orderId: 0, mode: 'preview' }) })).status, 400)
  assert.equal(f.calls.length, 0)
})

test('authorized admin endpoint previews then applies the displayed link with an audit record', async () => {
  const f = repairServiceFixture(), endpoint = f.load('lib/moysklad/order-link-endpoint')
  const req = { url: 'https://10coffee.test/api/orders/moysklad/relink', user: { id: 7, collection: 'admins', role: 'integration_operator' },
    headers: new Headers({ 'content-type': 'application/json', origin: 'https://10coffee.test', host: '10coffee.test' }), json: async () => ({ orderId: 160, mode: 'preview' }) }
  const previewResponse = await endpoint.handleOrderLinkRepair(req)
  assert.equal(previewResponse.status, 200)
  const plan = await previewResponse.json()
  assert.equal(plan.ok, true)
  assert.equal(f.logs.length, 0)
  const applyResponse = await endpoint.handleOrderLinkRepair({ ...req, json: async () => ({ orderId: 160, mode: 'apply', fingerprint: plan.fingerprint }) })
  assert.equal(applyResponse.status, 200)
  assert.equal((await applyResponse.json()).changed, true)
  assert.equal(f.getRow().moysklad_customer_order_id, plan.remoteId)
  assert.equal(f.logs[0].previous.actorId, 7)
})

test('link repair validates both existing documents without changing business data and uses the normal order hash', () => {
  const f = fixture(), repair = f.load('lib/moysklad/order-link-repair')
  const data = repairFixture(), before = JSON.stringify(data)
  const hash = repair.validateOrderLinkRepair(data.order, data.items, data.doc, data.invoice, data.expected)
  assert.equal(hash, f.load('lib/moysklad/order-hash').computeOrderContentHash({ subtotal: 23990, discountAmount: 4798,
    deliveryCost: 0, total: 19192, items: [{ productName: 'Coffee', variantName: '1 кг, В зёрнах', quantity: 10, unitPrice: 2399 }] }))
  assert.equal(JSON.stringify(data), before)
  const repaired = { ...data.order, moysklad_customer_order_id: 'remote-order', moysklad_invoice_out_id: 'invoice', moysklad_sync_status: 'synced' }
  assert.deepEqual(repair.orderWithoutRepairMetadata(data.order), repair.orderWithoutRepairMetadata(repaired))
  assert.notDeepEqual(repair.orderWithoutRepairMetadata(data.order), repair.orderWithoutRepairMetadata({ ...repaired, payment_status: 'paid' }))
})

for (const [name, change] of [
  ['other buyer', x => { x.doc.agent.meta.href = '/counterparty/other' }],
  ['other organization', x => { x.invoice.organization.meta.href = '/organization/other' }],
  ['wrong invoice link', x => { x.invoice.customerOrder.meta.href = '/customerorder/other' }],
  ['other existing link', x => { x.order.moysklad_customer_order_id = 'other' }],
  ['changed amount', x => { x.order.total++ }],
  ['other product', x => { x.invoice.positions.rows[0].assortment.name = 'Other coffee' }],
  ['other quantity', x => { x.doc.positions.rows[0].quantity = 11 }],
  ['other price', x => { x.invoice.positions.rows[0].price++ }],
  ['unexpanded positions', x => { x.doc.positions.meta.size = 2 }],
  ['delivery', x => { x.order.delivery_cost = 100 }],
]) {
  test(`link repair refuses ${name}`, () => {
    const x = repairFixture(); change(x)
    assert.throws(() => fixture().load('lib/moysklad/order-link-repair').validateOrderLinkRepair(x.order, x.items, x.doc, x.invoice, x.expected))
  })
}

const moneyFixtures = [
  { name: 'mixed per-line rounding', total: 16214, rows: [[2, 615, 15, 185], [2, 605, 15, 182], [6, 2430, 15, 2187], [1, 1840, 5, 92]] },
  { name: 'discount rounded down', total: 20152, rows: [[12, 2399, 30, 8636]] },
  { name: 'discount rounded up', total: 8756, rows: [[5, 2399, 27, 3239]] },
  { name: 'exact percent unchanged', total: 9720, rows: [[5, 2430, 20, 2430]] },
  { name: 'six kilograms stay on one line', total: 11515.15, rows: [[6, 2399, 20, 2878.85]] },
  { name: 'discounted and full-price items coexist', total: 16784, rows: [[6, 2399, 15, 2159], [3, 500, 0, 0], [1, 3388, 10, 339]] },
  { name: 'delivery excluded from discount', total: 135, delivery: 35, rows: [[3, 50, 33.33, 50]] },
]

for (const data of moneyFixtures) {
  test(`order and invoice keep the site's exact total: ${data.name}`, async () => {
    const f = fixture({ config: { createInvoiceOnOrder: true, deliveryServiceId: 'delivery' }, respond: c => {
      if (c.method === 'POST' && /^entity\/(customerorder|invoiceout)$/.test(c.path)) {
        const body = JSON.parse(c.init.body)
        return Response.json({ id: c.path.split('/')[1], sum: body.positions.reduce((s, p) => s + Math.round(p.quantity * p.price * (1 - (p.discount || 0) / 100)), 0) })
      }
    } })
    Object.assign(f.params.order, { total: data.total, deliveryCost: data.delivery || 0, subtotal: data.rows.reduce((sum, row) => sum + row[0] * row[1], 0) })
    f.params.cartItems = data.rows.map(([quantity, price], i) => ({ ...f.params.cartItems[0], id: `item-${i}`, quantity, variant: { name: `Pack ${i}`, price } }))
    f.params.discountLines = data.rows.map((r, i) => ({ cartItemId: `item-${i}`, discountPercent: r[2], discountAmount: r[3] }))
    const result = await f.sync.syncOrderToMoysklad(f.params)
    assert.equal(result.success, true, result.error)
    const order = JSON.parse(writes(f, 'customerorder')[0].init.body)
    const invoice = JSON.parse(writes(f, 'invoiceout')[0].init.body)
    assert.deepEqual(order.positions, invoice.positions)
    assert.equal(order.positions.reduce((s, p) => s + Math.round(p.quantity * p.price * (1 - (p.discount || 0) / 100)), 0), data.total * 100)
    assert.equal(order.positions.reduce((s, p) => s + p.quantity, 0), data.rows.reduce((s, r) => s + r[0], 0) + (data.delivery ? 1 : 0))
    assert.equal(order.positions.length, data.rows.length + (data.delivery ? 1 : 0))
    data.rows.forEach(([quantity, price, discountPercent, discountAmount], i) => {
      const position = order.positions[i]
      assert.equal(position.quantity, quantity)
      assert.equal(position.discount || 0, discountPercent)
      assert.equal(Math.round(position.quantity * position.price * (1 - (position.discount || 0) / 100)), Math.round((quantity * price - discountAmount) * 100))
      if (Math.round(quantity * price * 100 * (1 - discountPercent / 100)) === Math.round((quantity * price - discountAmount) * 100)) {
        assert.equal(position.price, price * 100)
      }
    })
    assert.ok(order.positions.every(p => Number.isFinite(p.price) && p.price >= 0 && p.quantity > 0))
    assert.equal(order.name, '10C-00382')
    if (data.name === 'exact percent unchanged') assert.equal(order.positions[0].discount, 20)
    if (data.delivery) assert.equal(order.positions.at(-1).price, data.delivery * 100)
    assert.equal(f.updates.at(-1).data.total, undefined)
  })
}

test('legacy discounts and global rounding are reconciled without changing assortment, VAT or quantity', () => {
  const { reconcileMoyskladOrderTotals, moyskladPositionsSum } = fixture().load('lib/moysklad/order-totals')
  const position = { price: 10100, quantity: 3, discount: 10, vat: 22, assortment: { meta: { href: 'product' } } }
  const result = reconcileMoyskladOrderTotals([position], ['item'], [{ cartItemId: 'item', discountPercent: 10 }], 273)
  assert.equal(moyskladPositionsSum(result), 27300)
  assert.equal(result.length, 1)
  assert.equal(result[0].discount, 10)
  assert.equal(result.reduce((s, p) => s + p.quantity, 0), 3)
  assert.ok(result.every(p => p.vat === 22 && p.assortment.meta.href === 'product'))
  assert.equal(position.price, 10100)
  const small = { ...position, quantity: 1, price: 100 }
  assert.equal(moyskladPositionsSum(reconcileMoyskladOrderTotals([small, small], ['a', 'b'], [
    { cartItemId: 'a', discountPercent: 10 }, { cartItemId: 'b', discountPercent: 10 },
  ], 1)), 100)
})

test('fractional kopeck prices preserve percentages and whole quantities across rounding cases', () => {
  const { reconcileMoyskladOrderTotals, moyskladPositionsSum } = fixture().load('lib/moysklad/order-totals')
  for (const quantity of [1, 2, 3, 5, 6, 12, 40, 500]) {
    for (const price of [61500, 239900, 243055]) {
      for (const discount of [5, 15, 20, 27, 30, 33.33, 99.99]) {
        const gross = price * quantity
        const amount = Math.min(gross, Math.round(gross * discount / 10000) * 100)
        const target = gross - amount
        const position = { price, quantity, discount, vat: 22, assortment: { meta: { href: 'product' } } }
        const output = reconcileMoyskladOrderTotals([position], ['item'], [{ cartItemId: 'item', discountPercent: discount, discountAmount: amount / 100 }], target / 100, gross / 100)
        assert.equal(output.length, 1)
        assert.equal(output[0].quantity, quantity)
        assert.equal(output[0].discount, discount)
        assert.equal(output[0].vat, 22)
        assert.equal(output[0].assortment, position.assortment)
        assert.equal(moyskladPositionsSum(output), target)
      }
    }
  }
})

test('large mismatch or invalid money prevents document writes', async () => {
  for (const total of [1, -1, NaN]) {
    const f = fixture()
    f.params.order.total = total
    const result = await f.sync.syncOrderToMoysklad(f.params)
    assert.ok(result.error)
    assert.equal(writes(f, 'customerorder').length, 0)
  }
})

test('even a small changed item price is not hidden as discount rounding', async () => {
  const f = fixture()
  Object.assign(f.params.order, { subtotal: 500.1, total: 400 })
  f.params.discountLines = [{ cartItemId: 'line', discountPercent: 20, discountAmount: 100 }]
  assert.match((await f.sync.syncOrderToMoysklad(f.params)).error, /подытогу/)
  assert.equal(writes(f, 'customerorder').length, 0)
})

test('zero and full discounts keep exact zero and full totals', () => {
  const { reconcileMoyskladOrderTotals, moyskladPositionsSum } = fixture().load('lib/moysklad/order-totals')
  for (const discount of [0, 100]) {
    const p = { price: 12345, quantity: 7, discount, assortment: { meta: { href: 'p' } } }
    const total = discount ? 0 : 864.15
    const result = reconcileMoyskladOrderTotals([p], ['line'], [{ cartItemId: 'line', discountPercent: discount }], total, 864.15)
    assert.equal(moyskladPositionsSum(result), Math.round(total * 100))
    assert.equal(result[0].quantity, 7)
  }
})

for (const entity of ['customerorder', 'invoiceout']) {
  test(`wrong returned ${entity} sum keeps its ID and never reports synced`, async () => {
    const f = fixture({ config: { createInvoiceOnOrder: true }, respond: c => {
      if (c.method === 'POST' && /^entity\/(customerorder|invoiceout)$/.test(c.path)) {
        return Response.json({ id: c.path.split('/')[1], sum: c.path === `entity/${entity}` ? 49999 : 50000 })
      }
    } })
    f.params.order.total = 500
    assert.match((await f.sync.syncOrderToMoysklad(f.params)).error, /отличающуюся/)
    const update = f.updates.at(-1).data
    assert.equal(update.moyskladSyncStatus, 'error')
    assert.equal(update.moyskladCustomerOrderId, 'customerorder')
    if (entity === 'invoiceout') assert.equal(update.moyskladInvoiceOutId, 'invoiceout')
    else assert.equal(writes(f, 'invoiceout').length, 0)
  })
}

test('read recovers after HTTP 503 and waits before retrying', async () => {
  const f = fixture({ respond: (call, n) => n === 1 ? unavailable() : Response.json({ rows: [{ id: 'existing' }] }) })
  const result = await f.client.moyskladGetList('entity/customerorder')
  assert.equal(result.rows[0].id, 'existing')
  assert.equal(f.calls.length, 2)
  assert.deepEqual(f.waits, [2000])
})

test('persistent 503 stops after three attempts with operation context but no private query/body', async () => {
  const f = fixture({ respond: unavailable })
  await assert.rejects(f.client.moyskladGetList('entity/counterparty', { filter: 'email=private@example.com' }), error => {
    assert.equal(error.status, 503)
    assert.match(error.message, /HTTP 503; GET entity\/counterparty/)
    assert.doesNotMatch(error.message, /private|example|html|test-only/)
    return true
  })
  assert.equal(f.calls.length, 3)
  assert.deepEqual(f.waits, [2000, 4000])
})

for (const method of ['POST', 'PUT', 'DELETE']) {
  test(`${method} is never replayed after an ambiguous 503 response`, async () => {
    const f = fixture({ respond: unavailable })
    await assert.rejects(f.client.moyskladRequest('entity/customerorder', { method }), { status: 503 })
    assert.equal(f.calls.length, 1)
    assert.deepEqual(f.waits, [])
  })
}

test('rate limiting respects server delay and retains rejected-write retries', async () => {
  const f = fixture({ respond: (call, n) => n === 1 ? Response.json({ errors: [{ code: 1049 }] }, {
    status: 429, headers: { 'Retry-After': '3', 'X-Lognex-Retry-After': '4500' },
  }) : Response.json({ id: 'created' }) })
  assert.equal((await f.client.moyskladRequest('entity/customerorder', { method: 'POST' })).id, 'created')
  assert.deepEqual(f.waits, [4500])
})

test('long Retry-After stops inline retries instead of retrying too early', async () => {
  const f = fixture({ respond: () => new Response('', { status: 503, headers: { 'Retry-After': '120' } }) })
  await assert.rejects(f.client.moyskladGetList('entity/customerorder'), { status: 503 })
  assert.equal(f.calls.length, 1)
  assert.deepEqual(f.waits, [])
})

test('authorization and validation errors are not retried', async () => {
  for (const status of [400, 401, 403, 404, 412]) {
    const f = fixture({ respond: () => Response.json({ errors: [{ code: 1000 }] }, { status }) })
    await assert.rejects(f.client.moyskladGetList('entity/customerorder'), { status })
    assert.equal(f.calls.length, 1)
  }
})

test('connection loss is retried for reads only', async () => {
  for (const method of ['GET', 'POST']) {
    const f = fixture({ respond: () => { throw new TypeError('fetch failed') } })
    await assert.rejects(f.client.moyskladRequest('entity/customerorder', { method }), { status: 0 })
    assert.equal(f.calls.length, method === 'GET' ? 3 : 1)
  }
})

test('every request has a deadline, and caller cancellation stops retries', async () => {
  const deadlines = []
  const f = fixture({ signalAPI: {
    timeout(ms) { deadlines.push(ms); return AbortSignal.abort(new Error('Timeout')) },
    any: AbortSignal.any,
  }, respond: call => call.init.signal.throwIfAborted() })
  await assert.rejects(f.client.moyskladGetList('entity/customerorder'), /не ответил за 30 секунд/)
  assert.deepEqual(deadlines, [30000, 30000, 30000])
  const abort = new AbortController()
  const g = fixture({ respond: unavailable, onDelay: () => abort.abort() })
  await assert.rejects(g.client.moyskladRequest('entity/customerorder', { signal: abort.signal }), { name: 'AbortError' })
  assert.equal(g.calls.length, 1)
})

test('failed order lookup stops creation and records a recoverable sync error', async () => {
  const f = fixture({ respond: c => c.path.startsWith('entity/customerorder?') ? unavailable() : undefined })
  const result = await f.sync.syncOrderToMoysklad(f.params)
  assert.match(result.error, /HTTP 503/)
  assert.equal(writes(f, 'customerorder').length, 0)
  assert.equal(f.updates.at(-1).data.moyskladSyncStatus, 'error')
})

test('failed invoice lookup keeps the exported order ID and does not create an invoice', async () => {
  const f = fixture({ config: { createInvoiceOnOrder: true },
    respond: c => c.path.startsWith('entity/invoiceout?') ? unavailable() : undefined })
  const result = await f.sync.syncOrderToMoysklad(f.params)
  assert.match(result.error, /GET entity\/invoiceout/)
  assert.equal(writes(f, 'invoiceout').length, 0)
  assert.equal(f.updates.at(-1).data.moyskladCustomerOrderId, 'remote-id')
})

test('failed stock loss lookup never creates a second stock loss', async () => {
  const f = fixture({ respond: unavailable })
  await assert.rejects(f.sync.ensureMoyskladStockLossForOrder(f.payload, {
    id: 382, items: [{ stockProductMoyskladId: 'product', stockQuantityKg: 0.25, stockPricePerKg: 200000 }],
  }), { status: 503 })
  assert.equal(writes(f, 'loss').length, 0)
})

test('failed linked counterparty read does not clear the company link or create a replacement', async () => {
  const f = fixture({ respond: c => c.method === 'GET' && c.path.startsWith('entity/counterparty/') ? unavailable() : undefined })
  f.params.company = { id: 'company', inn: '1234567890', moyskladCounterpartyId: 'linked' }
  const result = await f.sync.syncOrderToMoysklad(f.params)
  assert.match(result.error, /GET entity\/counterparty\/linked/)
  assert.equal(writes(f, 'counterparty').length, 0)
})

test('bundle lookup failure stops creation; the same process can retry successfully after recovery', async () => {
  let failing = true
  const f = fixture({ respond: c => failing && c.path.startsWith('entity/bundle?') ? unavailable() : undefined })
  f.params.cartItems[0].product.product_type_schema = 'coffee'
  Object.assign(f.params.cartItems[0].variant, { moysklad_id: 'variant', weight_grams: 250 })
  assert.match((await f.sync.syncOrderToMoysklad(f.params)).error, /GET entity\/bundle/)
  assert.equal(writes(f, 'bundle').length, 0)
  assert.equal(writes(f, 'customerorder').length, 0)
  failing = false
  assert.equal((await f.sync.syncOrderToMoysklad(f.params)).success, true)
  assert.equal(writes(f, 'bundle').length, 1)
})

test('unit lookup failure is not cached as piece accounting', async () => {
  let failing = true
  const f = fixture({ respond: c => c.path.includes('expand=uom')
    ? failing ? unavailable() : Response.json({ uom: { name: 'кг' } }) : undefined })
  f.params.cartItems[0].product.product_type_schema = 'coffee'
  f.params.cartItems[0].variant.weight_grams = 250
  assert.match((await f.sync.syncOrderToMoysklad(f.params)).error, /HTTP 503/)
  failing = false
  assert.match((await f.sync.syncOrderToMoysklad(f.params)).error, /Позиции не готовы/)
  assert.equal(f.calls.filter(c => c.path.includes('expand=uom')).length, 4)
  assert.equal(writes(f, 'customerorder').length, 0)
})

const uniquenessConflict = () => Response.json({
  errors: [{ code: 3006, error: "Нарушено ограничение уникальности параметра 'name'" }],
}, { status: 412 })

for (const entity of ['customerorder', 'invoiceout']) {
  test(`${entity} uniqueness conflict uses supported filters, remains unresolved, and never deletes documents`, async () => {
    const f = fixture({ config: { createInvoiceOnOrder: entity === 'invoiceout' }, respond: c => {
      if (decodeURIComponent(c.path).includes('archived')) {
        return Response.json({ errors: [{ code: 1034, error: "Неизвестное поле фильтрации 'archived'" }] }, { status: 412 })
      }
      if (c.path === `entity/${entity}` && c.method === 'POST') return uniquenessConflict()
    } })
    const result = await f.sync.syncOrderToMoysklad(f.params)
    assert.match(result.error, /конфликт уникальности.*3006/)
    assert.doesNotMatch(result.error, /находится в корзине|1034|archived/)
    assert.equal(result.trashed, false)
    assert.equal(writes(f, entity).length, 1)
    assert.equal(f.calls.some(c => c.method === 'DELETE' || decodeURIComponent(c.path).includes('archived')), false)
    assert.equal(f.updates.at(-1).data.moyskladSyncStatus, 'error')
    if (entity === 'invoiceout') assert.equal(f.updates.at(-1).data.moyskladCustomerOrderId, 'remote-id')
  })

  test(`${entity} created by a concurrent export is reused by external code without resetting order state`, async () => {
    let lookups = 0
    const externalCode = entity === 'customerorder' ? '10coffee-order-10C-00382' : '10C-00382-invoice'
    const f = fixture({ config: { createInvoiceOnOrder: entity === 'invoiceout', defaultOrderStateId: 'new-state' }, respond: c => {
      if (c.method === 'GET' && c.path.startsWith(`entity/${entity}?`)) {
        const query = new URLSearchParams(c.path.split('?')[1])
        if (query.get('filter') === 'externalCode=382') return Response.json({ rows: [] })
        assert.equal(query.get('filter'), `externalCode=${externalCode}`)
        return Response.json({ rows: ++lookups === 1 ? [] : [{ id: 'concurrent-id', externalCode,
          name: '10C-00382', organization: { id: 'organization' }, agent: { id: 'counterparty' },
          customerOrder: { id: 'remote-id' } }] })
      }
      if (c.path === `entity/${entity}` && c.method === 'POST') return uniquenessConflict()
      if (c.path === `entity/${entity}/concurrent-id` && c.method === 'PUT') return Response.json({ id: 'concurrent-id' })
    } })
    const result = await f.sync.syncOrderToMoysklad(f.params)
    assert.equal(result.success, true)
    assert.equal(entity === 'customerorder' ? result.moyskladOrderId : result.moyskladInvoiceOutId, 'concurrent-id')
    assert.equal(writes(f, entity).length, 1)
    assert.equal(f.calls.some(c => c.method === 'DELETE'), false)
    const update = f.calls.find(c => c.path === `entity/${entity}/concurrent-id` && c.method === 'PUT')
    assert.ok(update)
    assert.equal(JSON.parse(update.init.body).state, undefined)
  })

  test(`${entity} explicitly in trash is not deleted or recreated`, async () => {
    const f = fixture({ config: { createInvoiceOnOrder: entity === 'invoiceout' }, respond: c => {
      if (c.method === 'GET' && c.path === `entity/${entity}/trashed-id`) {
        return Response.json({ errors: [{ code: 3007, error: 'Документ находится в корзине' }] }, { status: 412 })
      }
    } })
    f.params.order[entity === 'customerorder' ? 'moyskladCustomerOrderId' : 'moyskladInvoiceOutId'] = 'trashed-id'
    const result = await f.sync.syncOrderToMoysklad(f.params)
    assert.equal(result.trashed, true)
    assert.match(result.error, /находится в корзине/)
    assert.equal(writes(f, entity).length, 0)
    assert.equal(f.calls.some(c => c.method === 'DELETE'), false)
  })
}

test('503 during conflict reconciliation stays an API failure and does not trigger another create', async () => {
  let lookups = 0
  const f = fixture({ respond: c => {
    if (c.method === 'GET' && c.path.startsWith('entity/customerorder?')
      && new URLSearchParams(c.path.split('?')[1]).get('filter') === 'externalCode=10coffee-order-10C-00382'
      && ++lookups > 1) return unavailable()
    if (c.path === 'entity/customerorder' && c.method === 'POST') return uniquenessConflict()
  } })
  const result = await f.sync.syncOrderToMoysklad(f.params)
  assert.match(result.error, /HTTP 503; GET entity\/customerorder/)
  assert.equal(result.trashed, false)
  assert.equal(writes(f, 'customerorder').length, 1)
})

// Exercise the full catalog import with HTTP and Payload storage isolated.
// Array updates replace rows, just as the importer asks Payload to do.
const packageFields = ['shippingLengthCm', 'shippingWidthCm', 'shippingHeightCm', 'shippingWeightGrams']
const packageValues = (row) => packageFields.map(field => row[field] ?? null)
const clone = value => JSON.parse(JSON.stringify(value))
const catalogRef = (type, id) => ({ meta: { type, href: `https://moysklad.invalid/entity/${type}/${id}` } })
const remoteCatalogVariant = (id, name, price = 500, stock = 10) => ({
  id, name: `Coffee (${name})`, ...catalogRef('variant', id),
  product: catalogRef('product', 'catalog-product'), salePrices: [{ value: price * 100 }], stock,
})
const localCatalogVariant = (moyskladId, id, size = 10) => ({
  id, moyskladId, moyskladType: 'variant', name: 'Old name', price: 1, isAvailable: true,
  shippingLengthCm: size, shippingWidthCm: size + 1, shippingHeightCm: size + 2,
  shippingWeightGrams: size * 100,
})

function catalogFixture({ storedVariants = [], remoteVariants = [], bySlug = false, newProduct = false } = {}) {
  const source = {
    folders: [{ id: 'catalog-root', name: 'Кофе' }, { id: 'catalog-group', name: 'Эспрессо', pathName: 'Кофе' }],
    product: { id: 'catalog-product', name: 'Coffee', ...catalogRef('product', 'catalog-product'),
      productFolder: catalogRef('productfolder', 'catalog-group'), stock: 10, salePrices: [{ value: 123400 }] },
    variants: clone(remoteVariants),
  }
  const database = {
    products: newProduct ? [] : [{ id: 7, name: 'Coffee', slug: 'coffee',
      moyskladId: bySlug ? null : 'catalog-product', variants: clone(storedVariants), description: 'Editor content' }],
    categories: [], 'product-types': [], clients: [],
  }
  const f = fixture({ respond: call => {
    const entity = call.path.split('?')[0]
    if (call.method !== 'GET') return
    const rows = {
      'entity/productfolder': source.folders,
      'entity/product': [source.product],
      'entity/variant': source.variants,
      'entity/assortment': [source.product, ...source.variants],
    }[entity]
    if (rows) return Response.json({ rows, meta: { size: rows.length } })
  } })
  let nextId = 100
  const persist = (collection, data) => {
    const saved = clone(data)
    if (collection === 'products') saved.variants = saved.variants.map(row => ({ ...row, id: row.id || `row-${nextId++}` }))
    return saved
  }
  f.payload.find = async ({ collection, where, limit = 1000 }) => {
    assert.ok(database[collection], `Unexpected collection: ${collection}`)
    const docs = database[collection].filter(doc => Object.entries(where || {}).every(([field, condition]) => {
      if ('equals' in condition) return doc[field] === condition.equals
      if ('in' in condition) return condition.in.includes(doc[field])
      throw new Error(`Unexpected filter: ${field}`)
    }))
    return { docs: clone(docs.slice(0, limit)), totalDocs: docs.length }
  }
  f.payload.update = async (input) => {
    f.updates.push(clone(input))
    const { collection, id, data } = input
    const index = database[collection].findIndex(doc => doc.id === id)
    assert.notEqual(index, -1)
    database[collection][index] = persist(collection, { ...database[collection][index], ...data })
    return clone(database[collection][index])
  }
  f.payload.create = async ({ collection, data }) => {
    const saved = persist(collection, { ...data, id: nextId++ })
    database[collection].push(saved)
    return clone(saved)
  }
  f.payload.delete = async () => { throw new Error('These fixtures must not delete catalog documents') }
  return { ...f, source, database, product: () => database.products[0],
    run: () => f.load('lib/moysklad/import-catalog').importMoyskladCatalog(f.payload) }
}

for (const bySlug of [false, true]) {
  test(`catalog import preserves packaging and row IDs across repeated syncs (${bySlug ? 'slug lookup' : 'MoySklad ID lookup'})`, async () => {
    const small = localCatalogVariant('small', 'local-small', 5)
    const large = localCatalogVariant('large', 'local-large', 20)
    const f = catalogFixture({ bySlug, storedVariants: [small, large], remoteVariants: [
      remoteCatalogVariant('small', '250 г, Молотый'), remoteCatalogVariant('large', '1 кг, В зёрнах', 2200),
    ] })
    for (let run = 0; run < 3; run++) {
      f.source.variants.reverse()
      f.source.variants.find(row => row.id === 'small').name = `Coffee (250 г, Молотый, новое имя ${run})`
      f.source.variants.find(row => row.id === 'large').salePrices[0].value = (2200 + run) * 100
      f.source.product.stock = run === 1 ? 0 : 10
      const result = await f.run()
      assert.equal(result.ok, true)
      assert.equal(result.stats.productsUpdated, 1)
      assert.equal(result.stats.skippedProducts.length, 0)
      const product = f.product()
      assert.equal(product.id, 7)
      assert.equal(product.description, 'Editor content')
      assert.equal(product.variants[0].moyskladId, 'large')
      for (const original of [small, large]) {
        const row = product.variants.find(item => item.moyskladId === original.moyskladId)
        assert.deepEqual(packageValues(row), packageValues(original))
        assert.equal(row.id, original.id)
        assert.equal(row.isAvailable, run !== 1)
      }
      assert.equal(product.variants[0].price, 2200 + run)
      assert.equal(product.variants[1].name, `250 г, Молотый, новое имя ${run}`)
      assert.equal(product.variants[1].weightGrams, 250)
    }
  })
}

test('catalog import preserves packaging on a product without MoySklad modifications', async () => {
  const row = { ...localCatalogVariant('catalog-product', 'local-single', 8), moyskladType: 'product' }
  const f = catalogFixture({ storedVariants: [row] })
  await f.run()
  assert.deepEqual(packageValues(f.product().variants[0]), packageValues(row))
  assert.equal(f.product().variants[0].id, row.id)
  assert.equal(f.product().variants[0].price, 1234)
  assert.equal(f.product().variants[0].moyskladType, 'product')
})

test('a new MoySklad variant never inherits packaging by name or array position', async () => {
  const old = { ...localCatalogVariant('removed', 'local-old'), name: '250 г' }
  const remaining = localCatalogVariant('remaining', 'local-remaining', 7)
  const f = catalogFixture({ storedVariants: [old, remaining], remoteVariants: [
    remoteCatalogVariant('new', '250 г'), remoteCatalogVariant('remaining', '100 г'),
  ] })
  await f.run()
  assert.deepEqual(f.product().variants.map(row => row.moyskladId), ['new', 'remaining'])
  assert.deepEqual(packageValues(f.product().variants[0]), [null, null, null, null])
  assert.notEqual(f.product().variants[0].id, old.id)
  assert.deepEqual(packageValues(f.product().variants[1]), packageValues(remaining))
})

test('unlinked local variants are not matched to imported variants by display name', async () => {
  const f = catalogFixture({ storedVariants: [{ ...localCatalogVariant(null, 'local-unlinked'), name: '250 г' }],
    remoteVariants: [remoteCatalogVariant('new', '250 г')] })
  await f.run()
  assert.deepEqual(packageValues(f.product().variants[0]), [null, null, null, null])
  assert.notEqual(f.product().variants[0].id, 'local-unlinked')
})

test('new products import normally and retain subsequently entered packaging', async () => {
  const f = catalogFixture({ newProduct: true, remoteVariants: [remoteCatalogVariant('new', '1 кг')] })
  const result = await f.run()
  assert.equal(result.stats.productsCreated, 1)
  assert.deepEqual(packageValues(f.product().variants[0]), [null, null, null, null])
  Object.assign(f.product().variants[0], { shippingLengthCm: 25, shippingWidthCm: 15, shippingHeightCm: 6, shippingWeightGrams: 1050 })
  const saved = clone(f.product().variants[0])
  await f.run()
  assert.deepEqual(packageValues(f.product().variants[0]), packageValues(saved))
  assert.equal(f.product().variants[0].id, saved.id)
})

test('partially filled and deliberately cleared packaging stays as the administrator saved it', async () => {
  const row = { ...localCatalogVariant('partial', 'local-partial'), shippingWidthCm: null }
  delete row.shippingHeightCm
  const f = catalogFixture({ storedVariants: [row], remoteVariants: [remoteCatalogVariant('partial', '250 г')] })
  await f.run()
  assert.deepEqual(packageValues(f.product().variants[0]), [10, null, null, 1000])
  f.product().variants[0].shippingLengthCm = null
  f.product().variants[0].shippingWeightGrams = 275
  await f.run()
  assert.deepEqual(packageValues(f.product().variants[0]), [null, null, null, 275])
})

function retailFixture({ account = false, promo, discountPercent = 0, loyaltyFailure = false, httpFailure = false, exportEnabled = true } = {}) {
  const products = [{ id: 10, name: 'Coffee', slug: 'coffee', moyskladId: 'retail-coffee',
    detailsSchema: 'coffee', isVisible: true, category: 1,
    variants: [{ id: 'pack-coffee', name: '250 г', moyskladId: 'coffee-250', moyskladType: 'variant',
      price: 855, weightGrams: 250, isAvailable: true, grindOptions: ['beans'] }] },
  { id: 11, name: 'Tea', slug: 'tea', moyskladId: 'retail-tea', detailsSchema: 'tea', isVisible: true, category: 2,
    variants: [{ id: 'pack-tea', name: '1 шт', moyskladId: 'retail-tea', moyskladType: 'product',
      price: 500, weightGrams: 100, isAvailable: true, grindOptions: [] }] }]
  const client = { id: 9, supabaseId: 'customer', fullName: 'Test Customer', email: 'customer@example.invalid',
    moyskladCounterpartyId: 'retail-buyer', discountPercent }
  const state = { order: null, httpFailure, loyaltyFailure, paymentCalls: [], remote: null, loyaltyCalls: 0, providerPayment: {}, paymentReads: 0, onPaymentRead: null, locks: [], heldLocks: new Set() }
  const dbConnection = { query: async (sql,params) => {
    const key=params?.[0]
    state.locks.push([sql,key])
    if(sql.includes('pg_try_advisory_lock')){
      const locked=!state.heldLocks.has(key)
      if(locked)state.heldLocks.add(key)
      return {rows:[{locked}]}
    }
    if(sql.includes('pg_advisory_unlock')){state.heldLocks.delete(key);return {rows:[]}}
    throw Error('Unexpected payment SQL: '+sql)
  },release:()=>{} }
  const f = fixture({ dbConnection, config: { createCounterparties: true, deliveryServiceId: 'delivery', syncOrdersOnCreate: exportEnabled }, respond: call => {
    if (state.httpFailure) return unavailable()
    if (call.path.startsWith('entity/product/retail-coffee')) return Response.json({ id: 'retail-coffee', uom: { name: 'кг' } })
    if (call.path === 'entity/counterparty/retail-buyer') return Response.json({ id: 'retail-buyer' })
    if (call.method === 'GET' && call.path.startsWith('entity/customerorder?')) {
      return Response.json({ rows: state.remote ? [state.remote] : [] })
    }
    if (call.method === 'GET' && call.path.startsWith('entity/customerorder/')) return Response.json(state.remote)
    if (['POST', 'PUT'].includes(call.method) && call.path.startsWith('entity/customerorder')) {
      const body = JSON.parse(call.init.body)
      state.remote = { ...body, id: 'retail-order', sum: body.positions.reduce((sum, p) =>
        sum + Math.round(p.quantity * p.price * (1 - (p.discount || 0) / 100)), 0) }
      return Response.json(state.remote)
    }
  }, extraMocks: {
    payload: { getPayload: async () => f.payload },
    '@payload-config': {},
    'next/cache': { unstable_cache: fn => fn },
    'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
    '@payloadcms/richtext-lexical/html': {},
    'lib/media': {},
    'lib/supabase/server': { createClient: async () => ({ auth: { getUser: async () => ({
      data: { user: account ? { id: 'customer', email: client.email } : null },
    }) } }) },
    'lib/actions/auth': {},
    'lib/payments/order-payment-token': { createOrderPaymentToken: () => 'test-payment-token' },
    'lib/payments/yookassa': {
      createYooKassaPayment: async input => {
        state.paymentCalls.push(input)
        return { ok: true, paymentId: 'test-payment', paymentUrl: 'https://payments.invalid/test' }
      },
      getYooKassaPayment: async () => {
        state.paymentReads++
        if(state.onPaymentRead)await state.onPaymentRead()
        return {ok:true,paymentId:'test-payment',orderId:'448',orderNumber:state.order.orderId,
          currency:'RUB',amountRubles:state.order.total,status:'paid',...state.providerPayment}
      },
    },
    'lib/cdek': { calculateTariff: async () => [{ delivery_mode: 2, delivery_sum: 341 }] },
    'lib/delivery-packaging': { getDeliveryPackagingSettings: async () => ({}),
      shippingLinesFromCartItems: () => [], calculateDeliveryPackaging: () => ({ packages: [], packagingCost: 0 }) },
    'lib/dadata-address': {}, 'lib/sochi-delivery': {}, 'lib/yandex-delivery': {},
    'lib/loyalty': {
      getLoyaltySnapshot: async () => ({ enabled: true, available: 1000, maxRedemptionPercent: 20 }),
      reserveLoyaltyPoints: async () => {}, releaseLoyaltyReservation: async () => {},
      finalizeLoyaltyForPaidOrder: async () => {
        state.loyaltyCalls++
        if (state.loyaltyFailure) throw new Error('loyalty database unavailable')
      },
    },
    'lib/payments/paid-order-cart': { clearPaidOrderCart: async () => ({ cleared: true }) },
    'lib/payments/paid-order-email': { sendPaidOrderConfirmation: async () => ({ sent: true }) },
  } })
  f.payload.find = async ({ collection, where }) => {
    if (collection === 'products') return { docs: clone(products.filter(p => !where?.name || p.name === where.name.equals)
      .filter(p => !where?.moyskladId || p.moyskladId === where.moyskladId.equals)) }
    if (collection === 'clients') return { docs: account ? [clone(client)] : [] }
    if (collection === 'promo-codes') return { docs: promo ? [{ id: 1, code: 'TEST', isActive: true,
      audience: 'individual', discountType: 'percentage', discountValue: promo }] : [] }
    if (collection === 'product-reviews') return { docs: [] }
    if (collection === 'orders') return { docs: state.order ? [clone(state.order)] : [], totalDocs: state.order ? 1 : 0, totalPages: 1 }
    throw new Error(`Unexpected collection: ${collection}`)
  }
  f.payload.create = async ({ collection, data }) => {
    assert.equal(collection, 'orders')
    state.order = { ...clone(data), id: 448, orderId: 'TEST-RETAIL', createdAt: new Date().toISOString(),
      items: data.items.map((item, index) => ({ ...clone(item), id: `saved-${index}` })) }
    return clone(state.order)
  }
  f.payload.update = async input => {
    f.updates.push(clone(input))
    if (input.collection === 'orders') {
      Object.assign(state.order, clone(input.data))
      return clone(state.order)
    }
    return { id: input.id, ...input.data }
  }
  f.payload.findByID = async ({ collection }) => {
    if (collection === 'orders') return clone(state.order)
    if (collection === 'clients') return clone(client)
    throw new Error(`Unexpected lookup: ${collection}`)
  }
  const input = { items: [{ id: 'cart-coffee', productId: '10', variantId: 'pack-coffee', quantity: 3 }],
    fullName: 'Test Customer', email: 'customer@example.invalid', phone: '+79991234567',
    deliveryMethod: 'self_pickup', acceptTerms: true, ...(promo ? { promoCode: 'TEST' } : {}) }
  return { ...f, state, products, input,
    checkout: () => f.load('lib/actions/shop-orders').createShopOrder(input),
    payment: () => f.load('lib/payments/yookassa-order-status').refreshYooKassaOrderPayment('test-payment'),
    webhook: () => f.load('app/api/shop/payments/yookassa/webhook/route').POST({
      json: async () => ({ event: 'payment.succeeded', object: { id: 'test-payment' } }),
    }),
  }
}

test('retail catalog loader retains the product and variant MoySklad identities', async () => {
  const f = retailFixture()
  const products = await f.load('lib/actions/products').getShopProducts()
  assert.equal(products[0].moysklad_id, 'retail-coffee')
  assert.equal(products[0].variants[0].moysklad_id, 'coffee-250')
  assert.equal(products[0].variants[0].moysklad_type, 'variant')
  assert.equal(products[1].variants[0].moysklad_type, 'product')
})

for (const options of [{}, { account: true }, { account: true, discountPercent: 10 }, { promo: 10 }]) {
  test(`retail exports only after confirmed payment, without a manual retry: ${JSON.stringify(options)}`, async () => {
    const f = retailFixture(options)
    const result = await f.checkout()
    assert.equal(result.success, true, result.error)
    assert.equal(f.state.order.paymentStatus, 'pending')
    assert.equal(f.state.order.moyskladSyncStatus, 'pending')
    assert.equal(f.calls.length, 0, 'checkout must not contact MoySklad')
    assert.equal(f.state.remote, null)
    assert.equal((await f.payment()).moyskladSynced, true)
    assert.equal(f.state.order.moyskladSyncStatus, 'synced', f.state.order.moyskladSyncError)
    assert.equal(f.state.order.moyskladCustomerOrderId, 'retail-order')
    assert.equal(f.state.remote.sum, Math.round(f.state.order.total * 100))
    assert.equal(writes(f, 'customerorder').length, 1)
    assert.equal(writes(f, 'invoiceout').length, 0)
    assert.equal(f.state.order.items[0].stockProductMoyskladId, 'retail-coffee')
    assert.equal(f.state.order.items[0].stockQuantityKg, 0.75)
    assert.equal(f.state.paymentCalls.length, 1)
    await f.payment()
    await f.payment()
    assert.equal(writes(f, 'customerorder').length, 1, 'payment callbacks must not duplicate the export')
  })
}

test('paid retail export preserves mixed coffee, ordinary goods and delivery', async () => {
  const f = retailFixture()
  f.input.items.push({ id: 'cart-tea', productId: '11', variantId: 'pack-tea', quantity: 2 })
  Object.assign(f.input, { deliveryMethod: 'cdek', address: 'Test pickup point', cdekCityCode: 1, cdekDeliveryType: 'pickup' })
  const result = await f.checkout()
  assert.equal(result.success, true, result.error)
  assert.equal(f.calls.length, 0)
  assert.equal((await f.payment()).moyskladSynced, true)
  assert.equal(f.state.order.moyskladSyncStatus, 'synced', f.state.order.moyskladSyncError)
  assert.equal(f.state.remote.positions.length, 3)
  assert.equal(f.state.remote.positions[1].assortment.meta.type, 'product')
  assert.equal(f.state.remote.sum, 390600)
})

test('paid retail export preserves loyalty redemption and the saved total', async () => {
  const f = retailFixture({ account: true })
  f.input.loyaltyPoints = 100
  f.input.items.push({ id: 'cart-tea', productId: '11', variantId: 'pack-tea', quantity: 1 })
  const result = await f.checkout()
  assert.equal(result.success, true, result.error)
  assert.equal(f.calls.length, 0)
  assert.equal((await f.payment()).moyskladSynced, true)
  assert.equal(f.state.order.moyskladSyncStatus, 'synced', f.state.order.moyskladSyncError)
  assert.equal(f.state.remote.sum, 296500)
  assert.equal(f.state.remote.positions[1].discount || 0, 0, 'points only discount coffee')
})

test('retail checkout reproduces the three-line rounding from order 10C-00448', async () => {
  const f = retailFixture({ account: true, promo: 10 })
  const template = clone(f.products[0])
  f.products.splice(0, f.products.length, ...[755, 905, 795].map((price, index) => ({
    ...clone(template), id: 20 + index, name: `Coffee ${index}`, moyskladId: `coffee-${index}`,
    variants: [{ ...clone(template.variants[0]), id: `pack-${index}`, moyskladId: `variant-${index}`, price }],
  })))
  f.input.items = f.products.map((product, index) => ({
    id: `cart-${index}`, productId: String(product.id), variantId: product.variants[0].id, quantity: 1,
  }))
  Object.assign(f.input, { deliveryMethod: 'cdek', address: 'Test pickup point', cdekCityCode: 1, cdekDeliveryType: 'pickup' })
  assert.equal((await f.checkout()).success, true)
  assert.equal(f.state.order.subtotal, 2455)
  assert.equal(f.state.order.discountAmount, 246)
  assert.equal(f.state.order.deliveryCost, 341)
  assert.equal(f.calls.length, 0)
  assert.equal((await f.payment()).moyskladSynced, true)
  assert.equal(f.state.order.moyskladSyncStatus, 'synced', f.state.order.moyskladSyncError)
  assert.equal(f.state.remote.sum, 255000)
  assert.equal(f.state.remote.positions.length, 4)
})

test('automatic background retry waits for payment then recovers a failed paid export', async () => {
  const f = retailFixture({ httpFailure: true })
  await f.checkout()
  const retry = () => f.load('lib/moysklad/order-retry').retryFailedMoyskladOrders(f.payload, { minAgeMs: 0 })
  assert.equal((await retry()).succeeded, 0)
  assert.equal(f.calls.length, 0)
  assert.equal(f.state.order.paymentStatus, 'pending')
  assert.equal((await f.payment()).moyskladSynced, false)
  assert.equal(f.state.order.paymentStatus, 'paid')
  f.state.httpFailure = false
  const result = await retry()
  assert.equal(result.succeeded, 1)
  assert.equal(f.state.order.paymentStatus, 'paid')
  assert.equal(f.state.order.moyskladSyncStatus, 'synced')
  assert.equal(writes(f, 'customerorder').length, 1)
})

test('loyalty amounts remain exact after automatic recovery with several coffee lines', async () => {
  const f = retailFixture({ account: true, httpFailure: true })
  f.input.loyaltyPoints = 101
  const secondCoffee = clone(f.products[0])
  Object.assign(secondCoffee, { id: 12, name: 'Coffee 2', moyskladId: 'retail-coffee-2' })
  Object.assign(secondCoffee.variants[0], { id: 'pack-coffee-2', moyskladId: 'coffee-2-250', price: 700 })
  f.products.push(secondCoffee)
  f.input.items.push({ id: 'cart-coffee-2', productId: '12', variantId: 'pack-coffee-2', quantity: 2 })
  f.input.items.push({ id: 'cart-tea', productId: '11', variantId: 'pack-tea', quantity: 1 })
  assert.equal((await f.checkout()).success, true)
  assert.equal(Math.round(f.state.order.items.reduce((sum, row) => sum + row.discountAmount, 0) * 100), 10100)
  f.state.httpFailure = false
  const result = await f.payment()
  assert.equal(result.moyskladSynced, true, result.moyskladError)
  assert.equal(f.state.remote.sum, 436400)
  assert.equal(f.state.remote.positions[2].discount || 0, 0)
})

test('repeated payment callback automatically recovers a paid export after a MoySklad outage', async () => {
  const f = retailFixture({ httpFailure: true })
  assert.equal((await f.checkout()).success, true)
  assert.equal(f.calls.length, 0)
  assert.equal((await f.payment()).moyskladSynced, false)
  assert.equal(f.state.order.moyskladSyncStatus, 'error')
  f.state.httpFailure = false
  assert.equal((await f.payment()).moyskladSynced, true)
  assert.equal(f.state.order.moyskladSyncStatus, 'synced')
  assert.equal(writes(f, 'customerorder').length, 1)
})

test('loyalty failure after payment does not prevent MoySklad export', async () => {
  const f = retailFixture({ httpFailure: true, loyaltyFailure: true })
  await f.checkout()
  f.state.httpFailure = false
  await f.payment().catch(() => {})
  assert.equal(f.state.order.paymentStatus, 'paid')
  assert.equal(f.state.loyaltyCalls, 1)
  assert.equal(f.state.order.moyskladSyncStatus, 'synced', f.state.order.moyskladSyncError)
})

test('webhook reports a transient MoySklad failure so the provider retries the notification', async () => {
  const f = retailFixture({ httpFailure: true })
  await f.checkout()
  const response = await f.webhook()
  assert.equal(response.status, 502)
  f.state.httpFailure = false
  assert.equal((await f.webhook()).status, 200)
  assert.equal(f.state.order.moyskladSyncStatus, 'synced')
  assert.equal(writes(f, 'customerorder').length, 1)
})

for (const paymentStatus of ['pending', 'invoiced', 'failed', 'cancelled', 'refunded', null, undefined]) {
  test(`unpaid retail cannot bypass the core export guard with force: ${paymentStatus}`, async () => {
    for (const channel of [{ salesChannel: 'retail' }, { customerType: 'individual' }]) {
      const f = fixture()
      Object.assign(f.params.order, channel, { paymentStatus, moyskladCustomerOrderId: 'existing-document' })
      f.params.force = true
      assert.equal((await f.sync.syncOrderToMoysklad(f.params)).skipped, true)
      assert.equal(f.calls.length, 0)
      assert.equal(f.updates.length, 0)
    }
  })
}

for (const [label, options] of [
  ['background', {}],
  ['full manual retry', { includeAllUnexported: true, includeExisting: true }],
  ['selected manual retry', { orderIds: [448] }],
  ['forced maintenance', { orderIds: [448], forceSelected: true }],
]) {
  test(`${label} cannot export an unpaid retail order even with an old sync error`, async () => {
    const f = retailFixture()
    await f.checkout()
    f.state.order.moyskladSyncStatus = 'error'
    f.state.order.moyskladSyncError = 'Previous premature export failure'
    const before = clone(f.state.order)
    const retry = f.load('lib/moysklad/order-retry')
    const result = await retry.retryFailedMoyskladOrders(f.payload, { minAgeMs: 0, ...options })
    assert.equal(result.succeeded, 0)
    assert.equal(result.failed, 0)
    assert.equal((await retry.syncOrderToMoyskladById(f.payload, 448)).skipped, true)
    assert.equal(f.calls.length, 0)
    assert.deepEqual(clone(f.state.order), before)
  })
}

for (const [label, providerPayment, expectedStatus] of [
  ['provider still pending', { status: 'pending' }, 200],
  ['provider cancelled payment', { status: 'cancelled' }, 200],
  ['different payment amount', { amountRubles: 1 }, 400],
  ['different order', { orderId: 'another-order' }, 400],
  ['different payment', { paymentId: 'another-payment' }, 400],
]) {
  test(`a payment.succeeded notification cannot export without verification: ${label}`, async () => {
    const f = retailFixture()
    await f.checkout()
    Object.assign(f.state.providerPayment, providerPayment)
    assert.equal((await f.webhook()).status, expectedStatus)
    assert.notEqual(f.state.order.paymentStatus, 'paid')
    assert.equal(f.calls.length, 0)
    assert.equal(f.state.remote, null)
  })
}

function matchesWhere(doc, where) {
  if (!where) return true
  return Object.entries(where).every(([field, condition]) => {
    if (field === 'and') return condition.every(part => matchesWhere(doc, part))
    if (field === 'or') return condition.some(part => matchesWhere(doc, part))
    return Object.entries(condition).every(([operator, expected]) => {
      const value = doc[field]
      if (operator === 'exists') return (value !== null && value !== undefined) === expected
      if (operator === 'equals') return value === expected
      if (operator === 'not_equals') return value !== null && value !== undefined && value !== expected
      if (operator === 'in') return expected.includes(value)
      throw new Error(`Unsupported test query operator: ${operator}`)
    })
  })
}

for (const forceSelected of [false, true]) {
  test(`selected unpaid retail is found and explains why it is skipped (force=${forceSelected})`, async () => {
    const unpaid = { ...retryOrder(448, '10C-00542'), salesChannel: 'retail', paymentStatus: 'pending', status: 'cancelled' }
    const paid = { ...retryOrder(449, 'OTHER-PAID'), salesChannel: 'retail', paymentStatus: 'paid' }
    const f = retryFixture([unpaid, paid])
    const before = clone(unpaid)
    const originalFind = f.payload.find
    f.payload.find = async input => input.collection === 'orders'
      ? { docs: [unpaid, paid].filter(order => matchesWhere(order, input.where)), totalPages: 1 }
      : originalFind(input)
    const result = await f.run({ orderIds: [448], forceSelected })
    assert.equal(result.checked, 1)
    assert.equal(result.excludedCount, 1)
    assert.equal(result.skippedTotal, 1)
    assert.equal(result.succeeded, 0)
    assert.equal(result.failed, 0)
    assert.match(f.events[0].message, /отмечено 1, найдено в базе 1/)
    assert.ok(f.events.some(event => /10C-00542: пропущен.*оплата не подтверждена/.test(event.message)))
    assert.equal(f.calls.length, 0)
    assert.equal(f.updates.length, 0)
    assert.deepEqual(clone(unpaid), before)
  })
}

test('unpaid retail orders cannot fill the background batch before a paid order', async () => {
  const unpaid = Array.from({ length: 30 }, (_, index) => ({
    ...retryOrder(index + 1, `UNPAID-${index}`), salesChannel: 'retail', paymentStatus: 'pending',
  }))
  const paid = { ...retryOrder(100, 'PAID'), salesChannel: 'retail', paymentStatus: 'paid' }
  const f = retryFixture([...unpaid, paid], call => {
    if (call.method === 'POST' && call.path === 'entity/customerorder') return Response.json({ id: 'paid-remote', sum: 50000 })
  })
  const originalFind = f.payload.find
  f.payload.find = async input => input.collection === 'orders'
    ? { docs: [...unpaid, paid].filter(order => matchesWhere(order, input.where)).slice(0, input.limit), totalPages: 1 }
    : originalFind(input)
  const result = await f.run({ includeAllUnexported: false, includeExisting: false })
  assert.equal(result.checked, 1)
  assert.equal(result.succeeded, 1, JSON.stringify(result.retried))
  assert.equal(JSON.parse(writes(f, 'customerorder')[0].init.body).name, 'PAID')
})

test('retry query and export guard preserve legacy and explicit wholesale channel rules', () => {
  const { canExportOrderToMoysklad, moyskladExportEligibilityWhere } = fixture().load('lib/moysklad/order-eligibility')
  for (const [order, expected] of [
    [{ salesChannel: 'retail', paymentStatus: 'pending' }, false],
    [{ salesChannel: 'retail', paymentStatus: 'paid' }, true],
    [{ salesChannel: null, customerType: 'individual', paymentStatus: 'pending' }, false],
    [{ customerType: 'individual', paymentStatus: 'paid' }, true],
    [{ salesChannel: 'wholesale', customerType: 'individual', paymentStatus: 'pending' }, true],
    [{ customerType: 'business', paymentStatus: 'pending' }, true],
    [{}, true],
  ]) {
    assert.equal(canExportOrderToMoysklad(order), expected, JSON.stringify(order))
    assert.equal(matchesWhere(order, moyskladExportEligibilityWhere), expected, JSON.stringify(order))
  }
})

function statusFixture(orders, remote = {}, config = {}, locked = true) {
  const queries = [], notifications = [], logs = [], loyalty = [], locks = []
  const dbConnection = { query: async (sql, params) => {
    locks.push({ sql, params })
    return { rows: [{ locked }] }
  }, release: () => { locks.push('released') } }
  const f = fixture({ config, dbConnection, respond: call => {
    const id = call.path.match(/^entity\/customerorder\/([^?]+)\?expand=state$/)?.[1]
    if (!id) throw new Error('Status sync must only read linked customer orders')
    const state = remote[id] || { state: { name: 'Собран' }, sum: 50000, payedSum: 0 }
    const local = orders.find(x => x.moyskladCustomerOrderId === id)
    return state instanceof Response ? state : Response.json({ id, name: local?.orderId,
      organization: { id: config.organizationId || 'organization' }, agent: { id: local?.moyskladCounterpartyId || 'counterparty' }, ...state })
  }, extraMocks: {
    'lib/order-line-discounts': {},
    'payload/admin/workspace': {},
    'lib/cdek-tracking-email': {},
    'lib/loyalty': {
      accrueLoyaltyForDeliveredOrder: async () => { loyalty.push('delivered') },
      releaseLoyaltyReservation: async () => { loyalty.push('release') },
      reverseLoyaltyForReturnedOrder: async () => { loyalty.push('reverse') },
    },
    'lib/moysklad/logs': { writeMoyskladLog: async input => { logs.push(input) } },
    'lib/supabase/admin': { createAdminClient: () => ({ from: () => ({
      insert: async input => { notifications.push(input); return {} },
    }) }) },
  } })
  const hooks = f.load('payload/collections/Orders').Orders.hooks
  f.payload.find = async input => {
    queries.push(input)
    const rows = orders.filter(order => matchesWhere(order, input.where)).sort((a, b) =>
      input.sort === 'id' ? a.id - b.id : b.id - a.id)
    const page = input.page || 1
    return { docs: rows.slice((page - 1) * input.limit, page * input.limit),
      hasNextPage: rows.length > page * input.limit, nextPage: page + 1 }
  }
  f.payload.update = async input => {
    f.updates.push(input)
    const doc = orders.find(order => order.id === input.id)
    const previousDoc = structuredClone(doc)
    const req = { payload: f.payload, context: input.context || {} }
    const data = await hooks.beforeChange[0]({ data: { ...input.data }, operation: 'update', req, originalDoc: doc })
    Object.assign(doc, data)
    await hooks.afterChange[0]({ doc, previousDoc, req })
    return doc
  }
  return { ...f, queries, notifications, logs, loyalty, hooks, locks,
    run: options => f.load('lib/moysklad/status-sync').syncMoyskladOrderStatuses(f.payload, options) }
}

const statusOrder = (id, fields = {}) => ({ id, orderId: `TEST-${id}`, salesChannel: 'retail',
  customerType: 'individual', paymentMethod: 'yookassa', paymentStatus: 'paid', status: 'paid',
  subtotal: 500, total: 500, moyskladCustomerOrderId: `remote-${id}`, ...fields })

test('status sweep includes an older linked order behind 520 unexported orders and all linked pages', async () => {
  const orders = Array.from({ length: 520 }, (_, i) => statusOrder(i + 100, { moyskladCustomerOrderId: null }))
  orders.push(statusOrder(1), statusOrder(2), statusOrder(3), statusOrder(4, { moyskladCustomerOrderId: '' }))
  const f = statusFixture(orders)
  const result = await f.run({ limit: 2 })
  assert.equal(result.ok, true)
  assert.equal(result.checked, 3)
  assert.equal(result.synced, 3)
  assert.equal(f.queries.length, 2)
  assert.equal(f.calls.length, 3)
  assert.ok(f.calls.every(call => call.method === 'GET'))
  assert.equal(orders.find(order => order.id === 1).status, 'ready')
  assert.ok(f.updates.every(input => !Object.hasOwn(input.data, 'paymentStatus')))
})

test('targeted status repair cannot touch another order', async () => {
  const orders = [statusOrder(1), statusOrder(2)]
  const f = statusFixture(orders)
  assert.equal((await f.run({ orderIds: [2] })).checked, 1)
  assert.equal(orders[0].status, 'paid')
  assert.equal(orders[1].status, 'ready')
})

for (const [name, status] of [['Подтвержден', 'confirmed'], ['Счет выставлен', 'invoiced'],
  ['Собран', 'ready'], ['Отгружен', 'shipped'], ['Доставлен', 'delivered'], ['Отменен', 'cancelled'], ['Возврат', 'returned']]) {
  test(`incoming ${name} survives the real order hook and preserves paid retail payment`, async () => {
    const order = statusOrder(1, { client: { supabaseId: 'customer' } })
    const f = statusFixture([order], { 'remote-1': { state: { name }, sum: 50000, payedSum: 0 } })
    const result = await f.run()
    assert.equal(result.ok, true)
    assert.equal(order.status, status)
    assert.equal(order.paymentStatus, 'paid')
    assert.equal(result.orders[0].status, order.status)
    assert.equal(f.notifications.length, 1)
    assert.equal(f.notifications[0].data.status, status)
    if (status === 'delivered') assert.deepEqual(f.loyalty, ['delivered'])
  })
}

test('retail refunds and cancelled/failed payments are never overwritten by MoySklad totals', async () => {
  for (const paymentStatus of ['refunded', 'cancelled', 'failed', 'pending']) {
    const order = statusOrder(1, { paymentStatus, status: 'cancelled' })
    const f = statusFixture([order], { 'remote-1': { state: { name: 'Подтвержден' }, sum: 50000, payedSum: 50000 } })
    assert.equal((await f.run()).ok, true)
    assert.equal(order.paymentStatus, paymentStatus)
    assert.equal(order.status, 'confirmed')
  }
})

test('wholesale cancellation is preserved even when MoySklad also reports a new full payment', async () => {
  const order = statusOrder(1, { salesChannel: 'wholesale', customerType: 'business', paymentMethod: 'invoice', paymentStatus: 'pending' })
  const f = statusFixture([order], { 'remote-1': { state: { name: 'Отменен' }, sum: 50000, payedSum: 50000 } })
  assert.equal((await f.run()).ok, true)
  assert.equal(order.paymentStatus, 'paid')
  assert.equal(order.status, 'cancelled')
})

test('unknown or missing MoySklad state records an error without resetting a paid order', async () => {
  for (const name of [undefined, 'Нестандартный статус']) {
    const order = statusOrder(1)
    const f = statusFixture([order], { 'remote-1': { state: { name } } })
    const result = await f.run()
    assert.equal(result.ok, false)
    assert.equal(result.errors.length, 1)
    assert.equal(order.status, 'paid')
    assert.equal(order.paymentStatus, 'paid')
    assert.equal(order.moyskladSyncStatus, 'error')
    assert.equal(f.notifications.length, 0)
  }
})

test('failed remote order does not block the next order, and disabled sync makes no queries', async () => {
  const f = statusFixture([statusOrder(1), statusOrder(2)], { 'remote-1': new Response('{}', { status: 404 }) })
  const result = await f.run()
  assert.equal(result.errors.length, 1)
  assert.equal(result.synced, 1)
  const disabled = statusFixture([statusOrder(1)], {}, { enabled: false })
  assert.equal((await disabled.run()).ok, false)
  assert.equal(disabled.queries.length, 0)
  assert.equal(disabled.calls.length, 0)
})

test('payment hook promotes only a newly confirmed payment and keeps later explicit order statuses', async () => {
  const f = statusFixture([])
  const hook = f.hooks.beforeChange[0]
  const req = { context: {} }
  const data = await hook({ data: { paymentStatus: 'paid' }, originalDoc: statusOrder(1, { status: 'cancelled', paymentStatus: 'pending' }), operation: 'update', req })
  assert.equal(data.status, 'paid', 'late provider success reopens the cancelled unpaid order')
  const updated = await hook({ data: { status: 'cancelled' }, originalDoc: statusOrder(1), operation: 'update', req })
  assert.equal(updated.status, 'cancelled', 'existing paid payment must not override explicit cancellation')
})

test('a concurrent status sync skips without reads or notifications and releases its connection', async () => {
  const f = statusFixture([statusOrder(1)], {}, {}, false)
  const result = await f.run()
  assert.equal(result.skipped, true)
  assert.equal(f.queries.length, 0)
  assert.equal(f.calls.length, 0)
  assert.equal(f.notifications.length, 0)
  assert.equal(f.locks.at(-1), 'released')
})

test('status sync releases its global lock when the local query fails', async () => {
  const f = statusFixture([statusOrder(1)])
  f.payload.find = async () => { throw new Error('database failure') }
  await assert.rejects(f.run, /database failure/)
  assert.match(f.locks.at(-2).sql, /pg_advisory_unlock/)
  assert.equal(f.locks.at(-1), 'released')
})

const remoteIdentity = fields => ({ id: 'old-remote', name: '10C-00382', externalCode: '382',
  organization: { id: 'organization' }, agent: { id: 'counterparty' }, ...fields })
const documentWrites = f => f.calls.filter(c => ['PUT', 'POST', 'DELETE'].includes(c.method)
  && /^entity\/(customerorder|invoiceout)(\/|$)/.test(c.path))

test('restored local ID collision creates a separate order and preserves all old documents', async () => {
  const old = remoteIdentity({ name: '10C-00515', externalCode: '449', sum: 3615000,
    agent: { id: 'old-buyer' }, moment: '2026-09-26 07:08:00',
    invoicesOut: [{ id: 'old-invoice' }], demands: [{ id: 'old-shipment' }] })
  const before = structuredClone(old)
  const f = fixture({ respond: c => {
    if (c.method === 'GET' && c.path.startsWith('entity/customerorder?')
      && new URLSearchParams(c.path.split('?')[1]).get('filter') === 'externalCode=449') {
      return Response.json({ rows: [old] })
    }
  } })
  Object.assign(f.params.order, { id: 449, orderId: '10C-00543' })
  assert.equal((await f.sync.syncOrderToMoysklad(f.params)).success, true)
  const sent = JSON.parse(writes(f, 'customerorder')[0].init.body)
  assert.equal(sent.externalCode, '10coffee-order-10C-00543')
  assert.equal(sent.name, '10C-00543')
  assert.equal(documentWrites(f).length, 1)
  assert.equal(documentWrites(f)[0].method, 'POST')
  assert.deepEqual(old, before)
})

for (const [label, changed] of [
  ['order number', { name: '10C-00515' }],
  ['organization', { organization: { id: 'another-organization' } }],
  ['counterparty', { agent: { id: 'another-buyer' } }],
  ['missing identity fields', { name: undefined, organization: undefined, agent: undefined }],
]) {
  test(`saved order link with wrong ${label} cannot overwrite a document even with force`, async () => {
    const f = fixture({ respond: c => c.method === 'GET' && c.path === 'entity/customerorder/old-remote'
      ? Response.json(remoteIdentity(changed)) : undefined })
    f.params.order.moyskladCustomerOrderId = 'old-remote'
    f.params.force = true
    assert.ok((await f.sync.syncOrderToMoysklad(f.params)).error)
    assert.equal(documentWrites(f).length, 0)
    assert.equal(f.updates.some(x => Object.hasOwn(x.data, 'moyskladCustomerOrderId')), false)
  })
}

test('a valid legacy numeric link can still update its own order without resetting the state', async () => {
  const f = fixture({ respond: c => c.method === 'GET' && c.path.startsWith('entity/customerorder?')
    && new URLSearchParams(c.path.split('?')[1]).get('filter') === 'externalCode=382'
    ? Response.json({ rows: [remoteIdentity({ state: { id: 'ready' } })] }) : undefined })
  assert.equal((await f.sync.syncOrderToMoysklad(f.params)).success, true)
  const changed = documentWrites(f)
  assert.equal(changed.length, 1)
  assert.equal(changed[0].path, 'entity/customerorder/old-remote')
  assert.equal(JSON.parse(changed[0].init.body).state, undefined)
  assert.equal(JSON.parse(changed[0].init.body).externalCode, '382')
})

test('missing saved order UUID is an error and never clears links or recreates documents', async () => {
  const f = fixture({ respond: c => c.path === 'entity/customerorder/missing' && c.method === 'GET'
    ? Response.json({ errors: [{ code: 1021, error: 'not found' }] }, { status: 404 }) : undefined })
  f.params.order.moyskladCustomerOrderId = 'missing'
  assert.ok((await f.sync.syncOrderToMoysklad(f.params)).error)
  assert.equal(documentWrites(f).length, 0)
  assert.equal(f.updates.some(x => Object.hasOwn(x.data, 'moyskladCustomerOrderId')), false)
})

test('a namespaced key with another order name or duplicate matches never authorizes an update', async () => {
  for (const rows of [[remoteIdentity({ name: 'OTHER' })], [remoteIdentity({}), remoteIdentity({ id: 'duplicate' })]]) {
    const f = fixture({ respond: c => c.method === 'GET' && c.path.startsWith('entity/customerorder?')
      ? Response.json({ rows }) : undefined })
    assert.ok((await f.sync.syncOrderToMoysklad(f.params)).error)
    assert.equal(documentWrites(f).length, 0)
  }
})

for (const [label, changed] of [
  ['another order', { customerOrder: { id: 'different-order' } }],
  ['another buyer', { agent: { id: 'another-buyer' } }],
  ['another organization', { organization: { id: 'another-organization' } }],
]) {
  test(`saved invoice belongs to ${label}: neither order nor invoice is changed`, async () => {
    const f = fixture({ config: { createInvoiceOnOrder: true }, respond: c => c.method === 'GET' && c.path === 'entity/invoiceout/old-invoice'
      ? Response.json({ ...remoteIdentity({ id: 'old-invoice' }), customerOrder: { id: 'old-remote' }, ...changed }) : undefined })
    f.params.order.moyskladCustomerOrderId = 'old-remote'
    f.params.order.moyskladInvoiceOutId = 'old-invoice'
    assert.ok((await f.sync.syncOrderToMoysklad(f.params)).error)
    assert.equal(documentWrites(f).length, 0)
  })
}

test('concurrent creation conflict cannot overwrite another counterparty document', async () => {
  let lookups = 0
  const f = fixture({ respond: c => {
    if (c.method === 'GET' && c.path.startsWith('entity/customerorder?')
      && new URLSearchParams(c.path.split('?')[1]).get('filter') === 'externalCode=10coffee-order-10C-00382') {
      return Response.json({ rows: ++lookups === 1 ? [] : [remoteIdentity({ agent: { id: 'another-buyer' } })] })
    }
    if (c.method === 'POST' && c.path === 'entity/customerorder') return uniquenessConflict()
  } })
  assert.match((await f.sync.syncOrderToMoysklad(f.params)).error, /контрагент/)
  assert.equal(documentWrites(f).length, 1)
  assert.equal(documentWrites(f)[0].method, 'POST')
})

test('00543 with old 36150-ruble financial links cannot be exported or import a shipped status', async () => {
  const bad = remoteIdentity({ name: '10C-00543', sum: 100, invoicedSum: 3615000, shippedSum: 3615000, payedSum: 3615000 })
  const f = fixture({ respond: c => c.method === 'GET' && c.path === 'entity/customerorder/old-remote'
    ? Response.json(bad) : undefined })
  Object.assign(f.params.order, { orderId: '10C-00543', moyskladCustomerOrderId: 'old-remote', total: 1 })
  assert.match((await f.sync.syncOrderToMoysklad(f.params)).error, /сверка документов/)
  assert.equal(documentWrites(f).length, 0)
  const order = statusOrder(1, { orderId: '10C-00543' })
  const incoming = statusFixture([order], { 'remote-1': { ...bad, state: { name: 'Отгружен' } } })
  assert.equal((await incoming.run()).errors.length, 1)
  assert.equal(order.status, 'paid')
  assert.equal(order.paymentStatus, 'paid')
  assert.equal(incoming.notifications.length, 0)
})

test('status import rejects a saved UUID pointing at another order', async () => {
  const order = statusOrder(1)
  const f = statusFixture([order], { 'remote-1': { name: 'OTHER', state: { name: 'Отгружен' } } })
  const result = await f.run()
  assert.equal(result.synced, 0)
  assert.equal(result.errors.length, 1)
  assert.equal(order.status, 'paid')
  assert.equal(f.notifications.length, 0)
})

test('a restored ID collision cannot be marked unchanged using the old content hash', async () => {
  const order = retryOrder(449, '10C-00543')
  order.moyskladSyncedHash = fixture().load('lib/moysklad/order-hash').computeOrderContentHash(order)
  const f = retryFixture([order], c => {
    if (c.method === 'GET' && c.path.startsWith('entity/customerorder?')
      && new URLSearchParams(c.path.split('?')[1]).get('filter')?.startsWith('organization=')) {
      return Response.json({ rows: [remoteIdentity({ name: '10C-00515', externalCode: '449' })] })
    }
    if (c.method === 'POST' && c.path === 'entity/customerorder') return Response.json({ id: 'new-remote', sum: 50000 })
  })
  const result = await f.run()
  assert.equal(result.succeeded, 1, JSON.stringify(result.retried))
  assert.equal(writes(f, 'customerorder').length, 1)
})

test('Runtime export disable cannot be bypassed by a forced direct export', async () => {
  const f = fixture({config:{syncOrdersOnCreate:false}})
  f.params.force = true
  assert.equal((await f.sync.syncOrderToMoysklad(f.params)).skipped,true)
  assert.equal(f.calls.length,0)
  assert.equal(f.updates.length,0)
})

test('a verified paid callback honours Runtime export disable while retaining the real payment', async () => {
  const f=retailFixture({exportEnabled:false})
  assert.equal((await f.checkout()).success,true)
  const result=await f.payment()
  assert.equal(result.ok,true)
  assert.equal(result.moyskladSynced,null)
  assert.equal(f.state.order.paymentStatus,'paid')
  assert.equal(f.state.remote,null)
  assert.equal(f.calls.length,0)
})

for (const [label,provider] of [
  ['different currency',{currency:'USD'}],['missing order metadata',{orderId:undefined}],
  ['different order number',{orderNumber:'OTHER'}],
]) test(`payment reconciliation refuses ${label} without changing the order`,async()=>{
  const f=retailFixture();await f.checkout();Object.assign(f.state.providerPayment,provider)
  const before=clone(f.state.order)
  assert.equal((await f.payment()).ok,false)
  assert.deepEqual(clone(f.state.order),before)
  assert.equal(f.calls.length,0)
  assert.equal(f.state.heldLocks.size,0)
})

test('concurrent webhook and polling use one payment lock and cannot create two MS orders',async()=>{
  const f=retailFixture();await f.checkout()
  let continueRead,started
  const reading=new Promise(resolve=>{started=resolve})
  f.state.onPaymentRead=()=>{started();return new Promise(resolve=>{continueRead=resolve})}
  const first=f.payment();await reading
  const busy=await f.webhook()
  assert.equal(busy.status,503)
  assert.equal(f.state.paymentReads,1)
  continueRead();assert.equal((await first).ok,true)
  assert.equal(writes(f,'customerorder').length,1)
  assert.equal(f.state.heldLocks.size,0)
})

test('a stale pending result cannot overwrite an already verified paid order',async()=>{
  const f=retailFixture();await f.checkout();assert.equal((await f.payment()).ok,true)
  const before=clone(f.state.order)
  f.state.providerPayment.status='pending'
  assert.equal((await f.payment()).ok,false)
  assert.deepEqual(clone(f.state.order),before)
  assert.equal(f.state.heldLocks.size,0)
})

function enableRealPaymentQueue(f) {
  const find=f.payload.find
  f.payload.find=async input=>input.collection==='orders'&&input.where?.and
    ? {docs:[f.state.order].filter(x=>matchesWhere(x,input.where)).map(clone),hasNextPage:false}
    : find(input)
  return ()=>f.load('lib/payments/yookassa-order-status').reconcilePendingYooKassaPayments()
}

test('a missed webhook is recovered by reconciliation only after the provider confirms payment',async()=>{
  const f=retailFixture();await f.checkout();const reconcile=enableRealPaymentQueue(f)
  f.state.providerPayment.status='pending'
  assert.equal((await reconcile()).updated,0)
  assert.equal(f.state.order.paymentStatus,'pending')
  assert.equal(writes(f,'customerorder').length,0)
  f.state.providerPayment.status='paid'
  const result=await reconcile()
  assert.equal(result.checked,1)
  assert.equal(result.updated,1)
  assert.equal(result.errors.length,0)
  assert.equal(f.state.order.paymentStatus,'paid')
  assert.equal(f.state.order.moyskladSyncStatus,'synced')
  assert.equal(writes(f,'customerorder').length,1)
  assert.equal((await reconcile()).checked,0)
  assert.equal(f.state.heldLocks.size,0)
})

test('reconciliation retries an unlinked paid export after a transient MS failure',async()=>{
  const f=retailFixture({httpFailure:true});await f.checkout();const reconcile=enableRealPaymentQueue(f)
  const failed=await reconcile()
  assert.equal(f.state.order.paymentStatus,'paid')
  assert.equal(f.state.order.moyskladSyncStatus,'error')
  assert.equal(failed.errors.length,1)
  f.state.httpFailure=false
  assert.equal((await reconcile()).errors.length,0)
  assert.equal(f.state.order.moyskladSyncStatus,'synced')
  assert.equal(writes(f,'customerorder').length,1)
})

test('a second reconciliation yields to the global lock without reading or updating orders',async()=>{
  const f=retailFixture();await f.checkout();const reconcile=enableRealPaymentQueue(f)
  f.state.heldLocks.add('yookassa-payment-reconciliation')
  const reads=f.state.paymentReads,updates=f.updates.length
  assert.equal((await reconcile()).skipped,true)
  assert.equal(f.state.paymentReads,reads)
  assert.equal(f.updates.length,updates)
})

test('pending payment recovery still saves the payment when MS export is paused',async()=>{
  const f=retailFixture({exportEnabled:false});await f.checkout();const reconcile=enableRealPaymentQueue(f)
  assert.equal((await reconcile()).updated,1)
  assert.equal(f.state.order.paymentStatus,'paid')
  assert.equal(writes(f,'customerorder').length,0)
  assert.equal((await reconcile()).checked,0,'paused MS retries must not repeatedly touch paid orders')
})

test('full queue is collected before status changes, and one failing payment does not stop other pages',async()=>{
  const orders=Array.from({length:205},(_,i)=>({id:i+1,orderId:'TEST-'+(i+1),paymentExternalId:'payment-'+(i+1),
    paymentMethod:'yookassa',paymentStatus:'pending',salesChannel:'retail',total:100}))
  const events=[],held=new Set()
  const f=fixture({config:{syncOrdersOnCreate:false},dbConnection:{query:async(sql,params)=>{
    if(sql.includes('pg_try_advisory_lock')){const locked=!held.has(params[0]);if(locked)held.add(params[0]);return{rows:[{locked}]}}
    held.delete(params[0]);return{rows:[]}
  },release:()=>{}},extraMocks:{payload:{getPayload:async()=>f.payload},'@payload-config':{},
    'lib/payments/yookassa':{getYooKassaPayment:async id=>{
      if(id==='payment-1')throw Error('transient provider failure')
      const n=Number(id.split('-')[1]);return{ok:true,paymentId:id,orderId:String(n),orderNumber:'TEST-'+n,currency:'RUB',amountRubles:100,status:'cancelled'}
    }},'lib/loyalty':{releaseLoyaltyReservation:async()=>{}},'lib/payments/paid-order-cart':{},'lib/payments/paid-order-email':{},'lib/yandex-delivery':{}}})
  f.payload.find=async input=>{
    if(input.where.and){events.push('page-'+input.page);const pending=orders.filter(x=>matchesWhere(x,input.where));return{
      docs:pending.slice((input.page-1)*input.limit,input.page*input.limit).map(clone),
      hasNextPage:input.page*input.limit<pending.length,nextPage:input.page+1}}
    return{docs:orders.filter(x=>matchesWhere(x,input.where)).map(clone)}
  }
  f.payload.findByID=async({id})=>clone(orders.find(x=>x.id===id))
  f.payload.update=async input=>{events.push('update');Object.assign(orders.find(x=>x.id===input.id),clone(input.data));return{}}
  const result=await f.load('lib/payments/yookassa-order-status').reconcilePendingYooKassaPayments()
  assert.equal(result.checked,205)
  assert.equal(result.updated,204)
  assert.equal(result.errors.length,1)
  assert.deepEqual(events.slice(0,2),['page-1','page-2'])
  assert.equal(orders[204].paymentStatus,'cancelled')
  assert.equal(orders[0].paymentStatus,'pending')
  assert.equal(held.size,0)
})

test('YooKassa GET uses a deadline and rejects unknown/malformed provider responses',async()=>{
  for(const data of [
    {id:'test-payment',status:'succeeded',amount:{value:'10.00',currency:'RUB'},metadata:{order_id:'404',order_number:'10C-00544'}},
    {id:'test-payment',status:'unknown-provider-state'}, {status:'succeeded'},
  ]){
    const f=fixture({respond:c=>{
      if(c.path.startsWith('https://api.yookassa.ru/v3/payments/')){
        assert.ok(c.init.signal instanceof AbortSignal)
        return Response.json(data)
      }
    },extraMocks:{payload:{getPayload:async()=>({findGlobal:async()=>({enabled:true,shopId:'test-shop',secretKey:'not-a-real-secret'})})},'@payload-config':{}}})
    const result=await f.load('lib/payments/yookassa').getYooKassaPayment('test-payment')
    assert.equal(result.ok,data.status==='succeeded'&&Boolean(data.id))
    if(result.ok)assert.equal(result.currency,'RUB')
  }
})
