/* eslint-disable @typescript-eslint/no-require-imports -- isolated server-action regression tests */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const root = path.join(__dirname, "..");

function fixture({ storageError = false } = {}) {
  const calls = [];
  const logs = [];
  const cache = new Map();
  const mocks = {
    payload: {
      getPayload: async () => ({
        create: async (input) => {
          calls.push(input);
          if (storageError) throw new Error("private database detail");
          return { id: 1 };
        },
      }),
    },
    "@payload-config": {},
  };

  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    }).outputText;
    const loaded = { exports: {} };
    cache.set(file, loaded);
    vm.runInNewContext(`(function(require,module,exports){${compiled}\n})`, {
      console: { error: (...args) => logs.push(args) },
    })(id => {
      if (id === "./contact-validation") return load("lib/actions/contact-validation.ts");
      if (id === "zod") return require("zod");
      if (!Object.hasOwn(mocks, id)) throw Error(`Unexpected dependency: ${id}`);
      return mocks[id];
    }, loaded, loaded.exports);
    return loaded.exports;
  }

  const form = new FormData();
  for (const [key, value] of Object.entries({
    name: "  Игорь  ",
    email: "igor@example.ru",
    phone: "",
    message: "Хочу обсудить сотрудничество",
    consent: "on",
  })) form.set(key, value);

  return {
    calls,
    logs,
    form,
    run: () => load("lib/actions/contact.ts").submitContactRequest({ success: false }, form),
  };
}

test("valid contact request is saved before success is returned", async () => {
  const f = fixture();
  const result = await f.run();
  assert.deepEqual({ ...result }, { success: true, name: "Игорь" });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].collection, "contact-requests");
  assert.equal(f.calls[0].overrideAccess, true);
  assert.deepEqual({ ...f.calls[0].data }, {
    name: "Игорь",
    email: "igor@example.ru",
    phone: "",
    message: "Хочу обсудить сотрудничество",
    consent: true,
    source: "landing-contact",
  });
});

test("invalid request is rejected without touching storage", async () => {
  const f = fixture();
  f.form.set("email", "");
  f.form.set("phone", "");
  const result = await f.run();
  assert.deepEqual({ ...result }, { success: false, error: "Укажите email или телефон для связи" });
  assert.equal(f.calls.length, 0);
});

test("storage failure returns a safe error without claiming success", async () => {
  const f = fixture({ storageError: true });
  const result = await f.run();
  assert.deepEqual({ ...result }, {
    success: false,
    error: "Не удалось отправить сообщение. Попробуйте позже.",
  });
  assert.equal(f.calls.length, 1);
  assert.match(JSON.stringify(f.logs), /private database detail/);
  assert.doesNotMatch(JSON.stringify(f.logs), /igor@example/);
});
