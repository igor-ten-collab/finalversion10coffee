/* eslint-disable @typescript-eslint/no-require-imports -- Node test runner */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const compiled = new Map()
function compile(file) {
  if (!compiled.has(file)) {
    compiled.set(file, ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText)
  }
  return compiled.get(file)
}

function fixture({ mailError = false, updateError = false, customerType = 'business', userExists = true, smtpEnv = {} } = {}) {
  const events = [], messages = []
  const user = { id: 'test-user', email: 'test@example.invalid', user_metadata: { customer_type: customerType } }
  let options
  const mocks = {
    '@/lib/supabase/admin': { createAdminClient: () => ({ auth: { admin: {
      listUsers: async () => ({ data: { users: userExists ? [user] : [] }, error: null }),
      createUser: async () => { events.push('create'); return { data: { user }, error: null } },
      updateUserById: async () => { events.push('update'); return { error: updateError ? new Error('database unavailable') : null } },
    } } }) },
    '@/lib/supabase/server': { createClient: async () => { events.push('session'); throw Error('Unexpected session creation') } },
    '@/lib/db': { dbQuery: async () => { events.push('profile'); return { rows: [] } } },
    '@/lib/utils/phone': { normalizeRussianPhone: value => value, isValidRussianPhone: () => true },
    'next/navigation': { redirect: () => { throw Error('Unexpected redirect') } },
    'next/cache': { revalidatePath() {} },
    crypto: require('node:crypto'),
    nodemailer: { createTransport: config => {
      options = config
      return { sendMail: async message => { messages.push(message); events.push('mail'); if (mailError) throw Error('SMTP unavailable'); return { accepted: [user.email] } } }
    } },
    payload: { getPayload: async () => ({ create: async () => { events.push('payload') } }) },
    '@payload-config': { default: {} },
  }
  const cache = new Map()
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports
    const loadedModule = { exports: {} }
    cache.set(file, loadedModule)
    vm.runInNewContext(`(function(require,module,exports){${compile(file)}\n})`, {
      process: { env: { SMTP_EMAIL: 'sender@example.invalid', SMTP_PASSWORD: 'test-only', ...smtpEnv } },
      console: { error() {}, info() {} },
    }, { filename: file })(id => {
      if (id === '@/lib/email/smtp') return load('lib/email/smtp.ts')
      if (!Object.hasOwn(mocks, id)) throw Error(`Unexpected dependency: ${id}`)
      return mocks[id]
    }, loadedModule, loadedModule.exports)
    return loadedModule.exports
  }
  return { actions: load('lib/actions/auth.ts'), events, messages, options }
}

test('SMTP failure leaves the old password unchanged and reports failure', async () => {
  const f = fixture({ mailError: true })
  const result = await f.actions.resetPassword({ email: 'test@example.invalid', customerType: 'business' })
  assert.match(result.error, /письмо.*Пароль не изменён/)
  assert.equal(result.success, undefined)
  assert.deepEqual(f.events, ['mail'])
})

test('successful SMTP acceptance happens before the password update', async () => {
  const f = fixture()
  const result = await f.actions.resetPassword({ email: 'test@example.invalid', customerType: 'business' })
  assert.equal(result.success, true)
  assert.deepEqual(f.events, ['mail', 'update'])
})

test('a failed password update is not reported as successful recovery', async () => {
  const f = fixture({ updateError: true })
  const result = await f.actions.resetPassword({ email: 'test@example.invalid' })
  assert.match(result.error, /Не удалось изменить пароль/)
  assert.equal(result.success, undefined)
})

test('a different account context neither sends an email nor changes credentials', async () => {
  const f = fixture({ customerType: 'individual' })
  const result = await f.actions.resetPassword({ email: 'test@example.invalid', customerType: 'business' })
  assert.match(result.error, /shop\.10coffee\.ru/)
  assert.deepEqual(f.events, [])
})

test('a nonexistent account neither sends an email nor changes credentials', async () => {
  const f = fixture({ userExists: false })
  assert.match((await f.actions.resetPassword({ email: 'test@example.invalid' })).error, /не найден/)
  assert.deepEqual(f.events, [])
})

test('registration preserves access when SMTP fails without claiming email delivery', async () => {
  const f = fixture({ mailError: true })
  const result = await f.actions.signUp({ email: 'test@example.invalid', phone: '+79991234567', full_name: 'Test' })
  assert.equal(result.success, true)
  assert.match(result.message, /письмо отправить не удалось/)
  assert.equal(result.password.length, 12)
  assert.deepEqual(f.events, ['create', 'profile', 'payload', 'mail'])
})

test('recovery keeps the domain sender separate from the Selectel SMTP login', async () => {
  const f = fixture({ smtpEnv: { SMTP_HOST: 'smtp.mail.selcloud.ru', SMTP_PORT: '1127',
    SMTP_SECURE: 'true', SMTP_USER: 'test-login', SMTP_EMAIL: 'noreply@example.invalid' } })
  assert.equal((await f.actions.resetPassword({ email: 'test@example.invalid' })).success, true)
  assert.equal(f.options.auth.user, 'test-login')
  assert.equal(f.messages[0].from, '"10coffee" <noreply@example.invalid>')
})
