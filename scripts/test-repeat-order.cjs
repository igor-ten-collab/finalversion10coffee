/* eslint-disable @typescript-eslint/no-require-imports -- isolated Node/React regression tests */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const root = path.resolve(__dirname, '..')

function fixture(overrides = {}) {
  const user = { id: 'retail-owner', user_metadata: {} }
  const product = { id: 41, name: 'Espresso Honduras', isVisible: true, variants: [
    { id: '250g', name: '250 г, В зернах', price: 700, isAvailable: true },
    { id: 'kg', name: '1 кг, В зернах', price: 2570, isAvailable: true },
  ] }
  const order = { id: 414, orderId: '10C-00449', client: { supabaseId: user.id }, items: [
    { productId: '41', productName: 'Espresso Honduras', variantName: '1 кг, В зернах', grindOption: 'В зёрнах', quantity: 1 },
  ], ...overrides.order }
  const products = overrides.products || [product]
  const cart = []
  const authScopes = []
  let nextCartId = 1
  const match = (doc, where) => where.and ? where.and.every(part => match(doc, part))
    : Object.entries(where).every(([key, value]) => String(doc[key]) === String(value.equals))
  const payload = {
    findByID: async ({ collection }) => {
      assert.equal(collection, 'orders')
      return order
    },
    find: async ({ collection, where, depth }) => {
      const rows = collection === 'products' ? products : cart
      return { docs: rows.filter(row => match(row, where)).map(row => collection === 'cart-items' && depth === 2
        ? { ...row, product: products.find(entry => entry.id === row.product) } : row) }
    },
    create: async ({ collection, data }) => {
      assert.equal(collection, 'cart-items')
      const doc = { id: nextCartId++, ...data }
      cart.push(doc)
      return doc
    },
    update: async ({ collection, where, data }) => {
      assert.equal(collection, 'cart-items')
      const docs = cart.filter(row => match(row, where))
      docs.forEach(doc => Object.assign(doc, data))
      return { docs }
    },
  }
  const mocks = {
    payload: { getPayload: async () => payload },
    '@payload-config': {},
    'next/cache': { revalidatePath() {} },
    nodemailer: { createTransport: () => ({}) },
    '@/lib/supabase/server': { createClient: async scope => {
      authScopes.push(scope)
      return { auth: { getUser: async () => ({ data: { user: overrides.anonymous ? null
        : { ...user, id: scope === 'individual' ? user.id : 'business-owner' } } }) } }
    } },
    '@/lib/product-types': { normalizeProductDetailsSchema: () => 'coffee' },
    '@/providers/auth-provider': { useAuth: () => ({ user, loading: false }) },
    '@/providers/cart-provider': { useCart: () => ({ reloadCart: async () => { throw new Error('Retail must not reload the wholesale provider') } }) },
    '@/components/shop/notification-menu': { NotificationMenu: () => null },
    '@/components/shop/pending-payment-card': { PendingPaymentCard: () => null },
    '@/components/shop/shop-ticker': { ShopTicker: () => null },
    '@/components/auth/auth-modal-store': { openAuthModal() {} },
    'next/navigation': { useRouter: () => ({ push() { throw new Error('Repeat must open the cart without navigating') } }) },
  }
  const actual = new Set(['lib/email/smtp.ts', 'lib/actions/orders.ts', 'lib/actions/cart.ts', 'lib/utils.ts',
    'lib/utils/format.ts', 'lib/utils/constants.ts', 'lib/utils/plural.ts', 'lib/utils/cdek-tracking.ts',
    'providers/guest-cart-provider.tsx', 'components/dashboard/orders-list.tsx',
    'components/shop/retail-orders-list.tsx', 'components/shop/shop-header.tsx'])
  const cache = new Map()
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports
    const mod = { exports: {} }
    cache.set(file, mod)
    const source = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText
    const localRequire = id => {
      if (Object.hasOwn(mocks, id)) return mocks[id]
      const relative = id.startsWith('@/') ? id.slice(2)
        : id.startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(file), id)) : null
      if (relative) {
        const target = relative + (fs.existsSync(path.join(root, relative + '.tsx')) ? '.tsx' : '.ts')
        return actual.has(target) || target.startsWith('components/ui/') ? load(target) : {}
      }
      return require(id)
    }
    vm.runInThisContext(`(function(require,module,exports){${source}\n})`, { filename: file })(localRequire, mod, mod.exports)
    return mod.exports
  }
  return { load, cart, order, product, products, authScopes, mocks }
}

test('retail repeat restores the exact product, pack, grind and quantity in the individual cart', async () => {
  const f = fixture()
  f.order.items[0].quantity = 3
  f.product.name = 'Espresso Honduras updated'
  const result = await f.load('lib/actions/orders.ts').repeatOrder('414', 'individual')
  assert.equal(result.success, true)
  assert.deepEqual(f.cart, [{ id: 1, clientId: 'retail-owner', product: 41, variantId: 'kg', quantity: 3, grindOption: 'В зёрнах' }])
  assert.ok(f.authScopes.every(scope => scope === 'individual'))
})

test('retail repeat cannot read or add another customer order', async () => {
  const f = fixture({ order: { client: { supabaseId: 'someone-else' } } })
  assert.equal((await f.load('lib/actions/orders.ts').repeatOrder('414', 'individual')).success, undefined)
  assert.equal(f.cart.length, 0)
})

test('anonymous repeat is rejected', async () => {
  const f = fixture({ anonymous: true })
  assert.equal((await f.load('lib/actions/orders.ts').repeatOrder('414', 'individual')).error, 'Не авторизован')
  assert.equal(f.cart.length, 0)
})

test('wholesale repeat still uses the business session', async () => {
  const f = fixture({ order: { client: { supabaseId: 'business-owner' } } })
  assert.equal((await f.load('lib/actions/orders.ts').repeatOrder('414')).success, true)
  assert.equal(f.cart[0].clientId, 'business-owner')
  assert.ok(f.authScopes.every(scope => scope === 'business'))
})

test('missing products and unavailable packs are not replaced with another product or weight', async () => {
  for (const change of ['deleted', 'hidden', 'unavailable', 'renamed-pack']) {
    const f = fixture()
    if (change === 'deleted') f.order.items[0].productId = '999'
    if (change === 'hidden') f.product.isVisible = false
    if (change === 'unavailable') f.product.variants[1].isAvailable = false
    if (change === 'renamed-pack') f.product.variants[1].name = 'Different pack'
    assert.equal((await f.load('lib/actions/orders.ts').repeatOrder('414', 'individual')).success, undefined, change)
    assert.equal(f.cart.length, 0, change)
  }
})

test('legacy names resolve and partial availability is reported without clearing the cart', async () => {
  const f = fixture()
  delete f.order.items[0].productId
  f.order.items.push({ productId: '999', productName: 'Deleted product', quantity: 1 })
  const orders = f.load('lib/actions/orders.ts')
  assert.equal((await orders.repeatOrder('414', 'individual')).skippedCount, 1)
  assert.equal((await orders.repeatOrder('414', 'individual')).skippedCount, 1)
  assert.equal(f.cart.length, 1)
  assert.equal(f.cart[0].quantity, 2)
})

test('rendered retail Repeat opens the populated header cart, blocks double clicks and persists after remount', async () => {
  const { Window } = await import('happy-dom')
  const window = new Window({ url: 'http://localhost/main/orders' })
  for (const key of ['document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLFormElement', 'HTMLSelectElement', 'Element',
    'Node', 'NodeFilter', 'DocumentFragment', 'ResizeObserver', 'MutationObserver', 'CustomEvent', 'Event', 'MouseEvent', 'PointerEvent', 'KeyboardEvent']) {
    Object.defineProperty(globalThis, key, { configurable: true, value: window[key] })
  }
  globalThis.window = window
  globalThis.getComputedStyle = window.getComputedStyle.bind(window)
  globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window)
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window)
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const React = require('react')
  const { createRoot } = require('react-dom/client')
  const { act } = React
  const h = React.createElement
  const f = fixture()
  const messages = []
  f.mocks['sonner'] = { toast: { success: text => messages.push(text), warning: text => messages.push(text), error: text => messages.push(text) } }
  f.mocks['next/link'] = { __esModule: true, default: ({ children, ...props }) => h('a', props, children) }
  const { GuestCartProvider } = f.load('providers/guest-cart-provider.tsx')
  const { ShopHeader } = f.load('components/shop/shop-header.tsx')
  const { RetailOrdersList } = f.load('components/shop/retail-orders-list.tsx')
  const products = [{ id: '41', name: 'Espresso Honduras', variants: [
    { id: '250g', name: '250 г, В зернах', price: 700 },
    { id: 'kg', name: '1 кг, В зернах', price: 2570 },
  ] }]
  let orders = [{ id: '414', order_id: '10C-00449', status: 'paid', payment_status: 'paid', total: 3,
    created_at: '2026-09-29T15:22:00Z', delivery_method: 'self_pickup',
    items: [{ product_name: 'Espresso Honduras', variant_name: '1 кг, В зернах', quantity: 1 }] }]
  const container = document.createElement('div')
  document.body.append(container)
  let reactRoot = createRoot(container)
  const tree = () => h(GuestCartProvider, null, h(ShopHeader, { products }), h(RetailOrdersList, { initialOrders: orders }))
  try {
    await act(async () => { reactRoot.render(tree()) })
    assert.equal(container.querySelector('aside[aria-label="Корзина"]'), null)
    const repeat = container.querySelector('button[aria-label="Повторить заказ"]')
    await act(async () => { repeat.click(); repeat.click() })
    const drawer = container.querySelector('aside[aria-label="Корзина"]')
    assert.ok(drawer, 'header cart opens after the saved cart reloads')
    assert.match(drawer.textContent, /Espresso Honduras/)
    assert.match(drawer.textContent, /1 кг, В зернах.*В зёрнах/)
    assert.match(drawer.textContent, /2\s?570/, 'cart uses current catalog prices, not the old paid 3 RUB')
    assert.equal(f.cart.length, 1)
    assert.equal(f.cart[0].quantity, 1, 'double click must not double the quantity')
    assert.equal(window.location.pathname, '/main/orders')
    assert.equal(messages.at(-1), 'Товары добавлены в корзину')
    await act(async () => { document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    assert.equal(container.querySelector('aside[aria-label="Корзина"]'), null)
    await act(async () => { reactRoot.unmount() })
    reactRoot = createRoot(container)
    await act(async () => { reactRoot.render(tree()) })
    const cartButton = Array.from(container.querySelectorAll('header button')).find(button => button.textContent.includes('Корзина'))
    await act(async () => { cartButton.click() })
    assert.match(container.querySelector('aside[aria-label="Корзина"]').textContent, /Espresso Honduras/)
    await act(async () => { container.querySelector('button[aria-label="Закрыть корзину"]').click() })
    assert.equal(container.querySelector('aside[aria-label="Корзина"]'), null)
    await act(async () => { cartButton.click() })
    await act(async () => { container.querySelector('aside[aria-label="Корзина"]').parentElement.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true })) })
    assert.equal(container.querySelector('aside[aria-label="Корзина"]'), null)
    await act(async () => {
      Array.from(container.querySelectorAll('span')).find(span => span.textContent === '10C-00449').click()
    })
    assert.ok(document.querySelector('[role="dialog"]'), 'order details open')
    orders = orders.map(order => ({ ...order, status: 'shipped' }))
    await act(async () => { reactRoot.render(tree()) })
    assert.match(document.querySelector('[role="dialog"]').textContent, /Отгружен/, 'open details use fresh server status')
    assert.match(container.textContent, /Отгружен/, 'the existing list accepts refreshed server props')
    await act(async () => {
      Array.from(document.querySelectorAll('[role="dialog"] button')).find(button => button.textContent === 'Повторить заказ').click()
    })
    assert.equal(document.querySelector('[role="dialog"]'), null, 'order details close before the cart can be used')
    assert.ok(container.querySelector('aside[aria-label="Корзина"]'))
    assert.notEqual(document.body.style.pointerEvents, 'none')
    assert.equal(f.cart[0].quantity, 2, 'a later intentional repeat adds to the existing cart')
    await act(async () => { container.querySelector('button[aria-label="Закрыть корзину"]').click() })
    f.order.items[0].productId = 'deleted'
    await act(async () => { container.querySelector('button[aria-label="Повторить заказ"]').click() })
    assert.equal(container.querySelector('aside[aria-label="Корзина"]'), null, 'failed repeat does not open an empty cart')
    assert.equal(f.cart[0].quantity, 2)
    assert.match(messages.at(-1), /Товары из заказа не найдены/)
    assert.equal(container.querySelector('button[aria-label="Повторить заказ"]').disabled, false)
  } finally {
    await act(async () => { reactRoot.unmount() })
    container.remove()
    await window.happyDOM.close()
  }
})
