/* eslint-disable @typescript-eslint/no-require-imports -- Node test runner */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../lib/email/smtp.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
}).outputText
function load(env) {
  const loaded = { exports: {} }
  vm.runInNewContext(`(function(require,module,exports){${source}\n})`, { process: { env } })(id => {
    assert.equal(id, 'nodemailer')
    return require(id)
  }, loaded, loaded.exports)
  return loaded.exports
}

test('existing Gmail settings still use the Gmail host and the email login', () => {
  const smtp = load({ SMTP_EMAIL: 'sender@example.invalid', SMTP_PASSWORD: 'test-only' })
  const transport = smtp.createSmtpTransport()
  assert.equal(transport.transporter.options.host, 'smtp.gmail.com')
  assert.equal(transport.transporter.options.port, 465)
  assert.equal(transport.transporter.options.secure, true)
  assert.equal(transport.transporter.options.auth.user, 'sender@example.invalid')
  transport.close()
})

test('Selectel uses TLS on port 1127 and its own login without a Gmail override', () => {
  const smtp = load({ SMTP_HOST: 'smtp.mail.selcloud.ru', SMTP_PORT: '1127', SMTP_SECURE: 'true',
    SMTP_USER: 'test-login', SMTP_EMAIL: 'noreply@example.invalid', SMTP_PASSWORD: 'test-api-key' })
  const transport = smtp.createSmtpTransport()
  const options = transport.transporter.options
  assert.equal(options.host, 'smtp.mail.selcloud.ru')
  assert.equal(options.port, 1127)
  assert.equal(options.secure, true)
  assert.equal(options.service, undefined)
  assert.equal(options.auth.user, 'test-login')
  assert.equal(options.auth.pass, 'test-api-key')
  transport.close()
})

test('port 1126 requires STARTTLS before sending credentials', () => {
  const smtp = load({ SMTP_HOST: 'smtp.mail.selcloud.ru', SMTP_PORT: '1126', SMTP_SECURE: 'false' })
  const options = smtp.getSmtpOptions()
  assert.equal(options.secure, false)
  assert.equal(options.requireTLS, true)
})

test('blank custom settings keep the Gmail preset and an optional separate login', () => {
  const options = load({ SMTP_HOST: ' ', SMTP_USER: 'account@example.invalid', SMTP_EMAIL: 'sender@example.invalid' }).getSmtpOptions()
  assert.equal(options.service, 'gmail')
  assert.equal(options.auth.user, 'account@example.invalid')
})

test('invalid custom ports and TLS flags fail before a connection is attempted', () => {
  for (const port of ['abc', '0', '-1', '65536', '1127.5']) {
    assert.throws(() => load({ SMTP_HOST: 'smtp.example.invalid', SMTP_PORT: port }).createSmtpTransport(), /SMTP_PORT/)
  }
  assert.throws(() => load({ SMTP_HOST: 'smtp.example.invalid', SMTP_SECURE: 'invalid' }).createSmtpTransport(), /SMTP_SECURE/)
})
