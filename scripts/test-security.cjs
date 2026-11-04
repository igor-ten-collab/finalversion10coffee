/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS test harness */
// Execute the real TypeScript entry points with isolated database/mail adapters.
// No production data, credentials, or network connections are used.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const root = path.resolve(__dirname, '..')

function fixture({ admin = null, customer = null, payloadOverrides = {}, extraMocks = {} } = {}) {
  const calls = []
  const payload = {
    auth: async () => ({ user: admin }),
    find: async (input) => { calls.push(['find', input]); return { docs: [] } },
    findByID: async (input) => { calls.push(['findByID', input]); throw new Error('Unexpected read') },
    update: async (input) => { calls.push(['update', input]); return { docs: [] } },
    ...payloadOverrides,
  }
  const auth = { getUser: async () => ({ data: { user: customer } }), updateUser: async (input) => {
    calls.push(['updateUser', input]); return { data: { user: customer }, error: null }
  } }
  const mocks = {
    payload: { getPayload: async () => payload },
    '@payload-config': {},
    'next/headers': { headers: async () => new Headers() },
    'next/cache': { revalidatePath() {} },
    'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
    nodemailer: { createTransport: () => ({ sendMail: async () => { calls.push(['mail']) } }) },
    '@/lib/supabase/server': { createClient: async () => ({ auth }) },
    '@/lib/supabase/admin': { createAdminClient: () => { throw new Error('Unexpected privileged DB access') } },
    '@/lib/db': { dbQuery: async (...args) => { calls.push(['sql', ...args]); return { rows: [] } } },
    '@/lib/auth/local': { verifyPassword: async () => null },
    '@/lib/moysklad/config': { getMoyskladConfig: () => { calls.push(['integration']); return { enabled: false } } },
    ...extraMocks,
  }
  const actual = new Set([
    'lib/email/smtp.ts',
    'lib/auth/payload-admin.ts', 'payload/access/adminRoles.ts',
    'lib/auth/profile-input.ts', 'lib/company-input.ts', 'lib/utils/phone.ts',
    'lib/discounts.ts', 'lib/product-types.ts',
  ])
  const cache = new Map()
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports
    const loadedModule = { exports: {} }
    cache.set(file, loadedModule)
    const source = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText
    const localRequire = (id) => {
      if (Object.hasOwn(mocks, id)) return mocks[id]
      if (id === 'zod' || id === 'crypto' || id.startsWith('node:')) return require(id)
      const relative = id.startsWith('@/') ? id.slice(2) + '.ts'
        : id.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(file), id)) + '.ts' : null
      if (actual.has(relative)) return load(relative)
      return {}
    }
    vm.runInThisContext(`(function(require,module,exports){${source}\n})`, { filename: file })(localRequire, loadedModule, loadedModule.exports)
    return loadedModule.exports
  }
  return { load, calls, payload }
}

for (const admin of [null, { id: 1, collection: 'clients', role: 'admin' }, { id: 1, collection: 'admins', role: 'support' }]) {
  test(`privileged mutations reject ${JSON.stringify(admin)}`, async () => {
    const f = fixture({ admin, customer: { id: 'customer', user_metadata: { user_type: 'admin' } } })
    const orders = f.load('lib/actions/orders.ts')
    await assert.rejects(() => orders.updateOrderStatus('42', 'paid'), /Нет доступа/)
    await assert.rejects(() => orders.sendPromoCodeEmail('test@example.invalid', 'X', '100%'), /Нет доступа/)
    const integration = f.load('lib/actions/moysklad.ts')
    for (const action of Object.values(integration)) await assert.rejects(() => action(), /Нет доступа/)
    assert.deepEqual(f.calls, [])
  })
}

test('anonymous order reads return no data', async () => {
  const f = fixture()
  const orders = f.load('lib/actions/orders.ts')
  assert.equal(await orders.getOrderById('42'), null)
  await assert.rejects(() => orders.getAllOrders(), /Нет доступа/)
  assert.deepEqual(f.calls, [])
})

test('customer order lookup restricts the query to authenticated owner', async () => {
  const f = fixture({ customer: { id: 'owner' } })
  f.payload.find = async (input) => {
    f.calls.push(['find', input])
    return { docs: input.collection === 'clients' ? [{ id: 8 }] : [] }
  }
  assert.equal(await f.load('lib/actions/orders.ts').getOrderById('victim-order'), null)
  const query = f.calls.find(([, input]) => input.collection === 'orders')[1]
  assert.deepEqual(query.where, { and: [{ id: { equals: 'victim-order' } }, { client: { equals: 8 } }] })
})

test('order list does not authorize by editable contact details', async () => {
  const f = fixture({ customer: { id: 'owner', email: 'victim@example.invalid' } })
  f.payload.find = async (input) => {
    f.calls.push(['find', input])
    return { docs: input.collection === 'clients' ? [{ id: 8, fullName: 'Victim', phone: '+79991234567' }] : [] }
  }
  await f.load('lib/actions/orders.ts').getClientOrders('individual')
  const query = f.calls.find(([, input]) => input.collection === 'orders')[1]
  assert.deepEqual(query.where.and[0], { client: { equals: 8 } })
})

test('staff reads retain Payload workspace access checks', async () => {
  const admin = { id: 1, collection: 'admins', role: 'retail_manager' }
  const f = fixture({ admin })
  await f.load('lib/actions/orders.ts').getAllOrders()
  assert.equal(f.calls[0][1].overrideAccess, false)
  assert.equal(f.calls[0][1].user, admin)
})

test('integration operator can reach authorized integration code', async () => {
  const f = fixture({ admin: { id: 1, collection: 'admins', role: 'integration_operator' } })
  await f.load('lib/actions/moysklad.ts').testMoyskladConnection()
  assert.deepEqual(f.calls, [['integration']])
})

test('profile API refuses forged privileges and unverified email changes before writes', async () => {
  for (const body of [{ data: { user_type: 'admin' } }, { data: { customer_type: 'business' } }, { data: { email_verified: true } }, { email: 'victim@example.invalid' }]) {
    const f = fixture({ customer: { id: 'owner', email: 'owner@example.invalid' } })
    const result = await f.load('app/api/auth/me/route.ts').PATCH({ json: async () => body })
    assert.equal(result.status, 400)
    assert.deepEqual(f.calls, [])
  }
})

test('profile parser preserves supported customer settings', () => {
  const { parseProfileMetadata } = fixture().load('lib/auth/profile-input.ts')
  const data = { full_name: 'Test', phone: '+79991234567', address: 'Test', delivery_method: 'self_pickup', avatar_url: '/api/avatar/test.jpg' }
  assert.deepEqual(parseProfileMetadata(data), data)
})

test('company inputs discard owner, primary key and integration ID injection', () => {
  const { createCompanyInput, updateCompanyInput } = fixture().load('lib/company-input.ts')
  const body = { name: 'Test', inn: '1234567890', id: 'victim', client_id: 'victim', moysklad_counterparty_id: 'victim' }
  for (const schema of [createCompanyInput, updateCompanyInput]) {
    assert.deepEqual(schema.parse(body), { name: 'Test', inn: '1234567890' })
  }
})

test('paid orders cannot be deleted or cancelled by a customer', async () => {
  const f = fixture({ customer: { id: 'owner' }, payloadOverrides: {
    find: async () => ({ docs: [{ id: 8 }] }),
    findByID: async () => ({ id: 42, client: 8, status: 'paid', paymentStatus: 'paid' }),
  } })
  const result = await f.load('lib/actions/orders.ts').deleteOrder('42')
  assert.ok(result.error)
  assert.deepEqual(f.calls, [])
})

test('customer cancellation keeps the record and includes owner/status filters', async () => {
  const f = fixture({ customer: { id: 'owner' }, payloadOverrides: {
    find: async () => ({ docs: [{ id: 8 }] }),
    findByID: async () => ({ id: 42, client: 8, status: 'new', paymentStatus: 'pending' }),
  } })
  f.payload.update = async (input) => { f.calls.push(['update', input]); return { docs: [{ id: 42 }] } }
  assert.equal((await f.load('lib/actions/orders.ts').deleteOrder('42')).success, true)
  assert.deepEqual(f.calls[0][1].data, { status: 'cancelled' })
  assert.deepEqual(f.calls[0][1].where.and, [
    { id: { equals: '42' } }, { client: { equals: 8 } },
    { status: { equals: 'new' } }, { paymentStatus: { equals: 'pending' } },
  ])
})

test('admin accounts cannot be read/updated by another auth collection or unlocked by staff', () => {
  const { Admins } = fixture().load('payload/collections/Admins.ts')
  const foreign = { req: { user: { id: 1, collection: 'clients', role: 'admin' } } }
  assert.equal(Admins.access.read(foreign), false)
  assert.equal(Admins.access.update(foreign), false)
  assert.equal(Admins.access.unlock({ req: { user: { id: 1, collection: 'admins', role: 'support' } } }), false)
  assert.equal(Admins.access.unlock({ req: { user: { id: 1, collection: 'admins', role: 'super_admin' } } }), true)
})

test('social login does not automatically link an existing email account', async () => {
  const writes = []
  const f = fixture({ extraMocks: {
    'next/server': { NextResponse: { redirect: (url) => Response.redirect(url) } },
    '@/lib/auth/social': {
      getSocialProvider: () => 'yandex', exchangeCodeForToken: async () => ({}),
      fetchSocialProfile: async () => ({ provider: 'yandex', providerId: '123', email: 'victim@example.invalid', name: 'Victim' }),
    },
    '@/lib/auth/local': {
      getUserBySocialIdentity: async () => null,
      upsertAuthUser: async () => ({ user: { id: 'existing' }, created: false }),
      linkSocialIdentity: async () => writes.push('link'),
      createSession: async () => writes.push('session'),
    },
  } })
  const response = await f.load('app/api/auth/social/callback/route.ts').GET({
    nextUrl: new URL('http://localhost/api/auth/social/callback?code=code&state=state'),
    cookies: { get: () => ({ value: JSON.stringify({ state: 'state', provider: 'yandex', expiresAt: Date.now() + 60000 }) }) },
  })
  assert.match(new URL(response.headers.get('location')).searchParams.get('social_error'), /Войдите по паролю/)
  assert.deepEqual(writes, [])
})
