/* eslint-disable @typescript-eslint/no-require-imports -- isolated API and filesystem tests */
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')
const compiled = new Map()
const id = '00000000-0000-4000-8000-000000000001'
const jpeg = Buffer.from([255, 216, 255, 217])

function fixture(t, { authenticated = true, env = {}, writeFails = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '10coffee-avatar-'))
  t.after(() => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep + '10coffee-avatar-'))
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const calls = [], cache = new Map()
  class NextResponse extends Response { static json(body, init) { return Response.json(body, init) } }
  class PutObjectCommand { constructor(input) { this.input = input; this.kind = 'put' } }
  class GetObjectCommand { constructor(input) { this.input = input; this.kind = 'get' } }
  const mocks = {
    'next/server': { NextResponse },
    '@/lib/supabase/server': { createClient: async () => ({ auth: { getUser: async () => ({ data: { user: authenticated ? { id } : null } }) } }) },
    '@aws-sdk/client-s3': { PutObjectCommand, GetObjectCommand, S3Client: class {
      constructor() { calls.push('s3-client') }
      async send(command) { calls.push(command); return { Body: { transformToByteArray: async () => jpeg }, ContentType: 'image/jpeg' } }
    } },
    'node:fs/promises': writeFails ? { ...require('node:fs/promises'), writeFile: async () => { throw Object.assign(Error('denied'), { code: 'EACCES' }) } } : require('node:fs/promises'),
  }
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports
    if (!compiled.has(file)) compiled.set(file, ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText)
    const loaded = { exports: {} }
    cache.set(file, loaded)
    vm.runInNewContext(`(function(require,module,exports){${compiled.get(file)}\n})`, {
      process: { env, cwd: () => directory }, Buffer, Date, console: { error() {} },
    })(name => {
      if (name === '@/lib/avatar-storage') return load('lib/avatar-storage.ts')
      if (Object.hasOwn(mocks, name)) return mocks[name]
      if (name.startsWith('node:')) return require(name)
      throw Error('Unexpected dependency: ' + name)
    }, loaded, loaded.exports)
    return loaded.exports
  }
  const request = (type = 'image/jpeg') => {
    const form = new FormData()
    form.set('file', new Blob([jpeg], { type }), 'avatar.jpg')
    return new Request('http://localhost/api/upload-avatar', { method: 'POST', body: form })
  }
  return { directory, calls, request, post: (...args) => load('app/api/upload-avatar/route.ts').POST(...args),
    get: filename => load('app/api/avatar/[filename]/route.ts').GET({}, { params: Promise.resolve({ filename }) }) }
}

test('without S3 an authenticated upload is written to disk and served by the avatar endpoint', async t => {
  const f = fixture(t)
  const result = await f.post(f.request())
  assert.equal(result.status, 200)
  assert.match((await result.json()).url, new RegExp(`/api/avatar/${id}.jpg`))
  assert.deepEqual(fs.readFileSync(path.join(f.directory, 'public/uploads/avatars', id + '.jpg')), jpeg)
  const response = await f.get(id + '.jpg')
  assert.equal(response.status, 200)
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), jpeg)
  assert.equal(response.headers.get('Content-Type'), 'image/jpeg')
  assert.deepEqual(f.calls, [])
})

test('configured S3 keeps the existing upload and read path', async t => {
  const f = fixture(t, { env: { S3_BUCKET: 'test-only', S3_ACCESS_KEY_ID: 'test', S3_SECRET_ACCESS_KEY: 'test' } })
  assert.equal((await f.post(f.request())).status, 200)
  assert.equal((await f.get(id + '.jpg')).status, 200)
  assert.deepEqual(f.calls.filter(c => typeof c === 'object').map(c => c.kind), ['put', 'get'])
  assert.equal(fs.existsSync(path.join(f.directory, 'public/uploads/avatars', id + '.jpg')), false)
})

test('anonymous uploads are rejected before storage writes', async t => {
  const f = fixture(t, { authenticated: false })
  assert.equal((await f.post(f.request())).status, 401)
  assert.deepEqual(fs.readdirSync(f.directory), [])
})

test('filesystem failure returns JSON instead of an empty server error', async t => {
  const f = fixture(t, { writeFails: true })
  const response = await f.post(f.request())
  assert.equal(response.status, 500)
  assert.match((await response.json()).error, /Не удалось сохранить аватар/)
})

test('missing avatars and traversal filenames return 404', async t => {
  const f = fixture(t)
  for (const filename of [id + '.jpg', '../secret', '..\\secret', 'other.txt']) assert.equal((await f.get(filename)).status, 404)
  assert.deepEqual(fs.readdirSync(f.directory), [])
})

test('non-image uploads are rejected before storage writes', async t => {
  const f = fixture(t)
  assert.equal((await f.post(f.request('application/pdf'))).status, 400)
  assert.deepEqual(fs.readdirSync(f.directory), [])
})

test('partial S3 configuration returns JSON and does not silently switch storage', async t => {
  const f = fixture(t, { env: { S3_BUCKET: 'test-only' } })
  const response = await f.post(f.request())
  assert.equal(response.status, 500)
  assert.ok((await response.json()).error)
  assert.deepEqual(fs.readdirSync(f.directory), [])
})
