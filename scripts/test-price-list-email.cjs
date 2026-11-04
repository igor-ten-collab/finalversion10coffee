/* eslint-disable @typescript-eslint/no-require-imports -- isolated email regression tests */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const root = path.join(__dirname, '..')
const compiled = new Map()

function fixture({ fileConfigured = true, downloadStatus = 200, mailError = false } = {}) {
  const calls = [], logs = [], cache = new Map()
  const pdf = Buffer.from('%PDF-1.7\nfixture')
  const mocks = {
    zod: require('zod'),
    payload: { getPayload: async () => ({
      create: async input => { calls.push(['create', input]); return { id: 91 } },
      update: async input => { calls.push(['update', input]); return {} },
    }) },
    '@payload-config': {},
    '@/lib/actions/site-settings': { getSiteSettings: async () => ({ priceListForm: {
      emailFile: fileConfigured ? { url: '/api/media/file/price.pdf', filename: 'price.pdf' } : undefined,
    } }) },
    nodemailer: { createTransport: () => ({ sendMail: async input => {
      calls.push(['mail', input])
      if (mailError) throw Object.assign(new Error('private recipient / secret'), { code: 'EAUTH', responseCode: 535, command: 'AUTH PLAIN' })
      return { messageId: '<fixture@example.invalid>', accepted: ['recipient@example.invalid'], rejected: [] }
    } }) },
  }
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports
    if (!compiled.has(file)) compiled.set(file, ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText)
    const loaded = { exports: {} }
    cache.set(file, loaded)
    vm.runInNewContext(`(function(require,module,exports){${compiled.get(file)}\n})`, {
      process: { env: { SMTP_EMAIL: 'sender@example.invalid', SMTP_PASSWORD: 'secret', NEXT_PUBLIC_SITE_URL: 'https://site.example.invalid' } },
      console: { error: (...args) => logs.push(args), info: (...args) => logs.push(args) },
      URL, Buffer, AbortSignal,
      fetch: async url => { calls.push(['fetch', String(url)]); return new Response(pdf, { status: downloadStatus }) },
    })(id => {
      if (id === '@/lib/email/smtp') return load('lib/email/smtp.ts')
      if (!Object.hasOwn(mocks, id)) throw Error(`Unexpected dependency: ${id}`)
      return mocks[id]
    }, loaded, loaded.exports)
    return loaded.exports
  }
  const form = new FormData()
  for (const [key, value] of Object.entries({ name: 'Test', email: 'recipient@example.invalid', phone: '+79991234567', company: '', consent: 'on' })) form.set(key, value)
  return { calls, logs, pdf, run: () => load('lib/actions/price-list.ts').submitPriceListRequest({ success: false }, form) }
}

test('missing PDF saves the request without sending mail or claiming an email success', async () => {
  const f = fixture({ downloadStatus: 500 })
  const result = await f.run()
  assert.equal(result.success, true)
  assert.equal(result.emailSent, false)
  assert.deepEqual(f.calls.map(([type]) => type), ['create', 'fetch'])
  assert.ok(JSON.stringify(f.logs).includes('PRICE_LIST_HTTP_ERROR'))
})

test('an unconfigured price list cannot send a message with a promised missing attachment', async () => {
  const f = fixture({ fileConfigured: false })
  assert.equal((await f.run()).emailSent, false)
  assert.deepEqual(f.calls.map(([type]) => type), ['create'])
})

test('SMTP rejection preserves the request and records safe diagnostics', async () => {
  const f = fixture({ mailError: true })
  assert.equal((await f.run()).emailSent, false)
  assert.deepEqual(f.calls.map(([type]) => type), ['create', 'fetch', 'mail'])
  const log = JSON.stringify(f.logs)
  assert.match(log, /EAUTH/)
  assert.doesNotMatch(log, /recipient@example|private recipient|secret/)
})

test('a downloaded PDF is attached and successful SMTP acceptance updates the request', async () => {
  const f = fixture()
  assert.equal((await f.run()).emailSent, true)
  assert.deepEqual(f.calls.map(([type]) => type), ['create', 'fetch', 'mail', 'update'])
  const attachment = f.calls.find(([type]) => type === 'mail')[1].attachments[0]
  assert.equal(attachment.filename, 'price.pdf')
  assert.deepEqual(attachment.content, f.pdf)
  assert.equal(f.calls.at(-1)[1].data.emailSent, true)
  assert.match(JSON.stringify(f.logs), /accepted/)
})
