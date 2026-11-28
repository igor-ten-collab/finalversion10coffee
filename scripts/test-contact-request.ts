import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseContactRequest } from "../lib/actions/contact-validation";
import { ContactRequests } from "../payload/collections/ContactRequests";

const valid = {
  name: "Игорь",
  email: "igor@example.ru",
  phone: "+79180000000",
  message: "Хочу обсудить сотрудничество",
  consent: true,
};

function expectError(input: Parameters<typeof parseContactRequest>[0], message: string) {
  const result = parseContactRequest(input);
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.error, message);
}

test("accepts a complete request and trims strings", () => {
  const result = parseContactRequest({ ...valid, name: "  Игорь  " });
  assert.deepEqual(result, { success: true, data: { ...valid, name: "Игорь" } });
});

test("accepts email only", () => {
  assert.equal(parseContactRequest({ ...valid, phone: "" }).success, true);
});

test("accepts phone only", () => {
  assert.equal(parseContactRequest({ ...valid, email: "" }).success, true);
});

test("rejects missing contacts", () => {
  expectError({ ...valid, email: "", phone: "" }, "Укажите email или телефон для связи");
});

test("rejects an invalid email", () => {
  expectError({ ...valid, email: "bad" }, "Введите корректный email");
});

test("rejects a short name", () => {
  expectError({ ...valid, name: "И" }, "Введите имя");
});

test("rejects a short message", () => {
  expectError({ ...valid, message: "Коротко" }, "Напишите сообщение (минимум 10 символов)");
});

test("rejects missing consent", () => {
  expectError({ ...valid, consent: false }, "Подтвердите согласие на обработку персональных данных");
});

test("contact requests deny unauthenticated API access", async () => {
  for (const key of ["create", "read", "update", "delete"] as const) {
    const rule = ContactRequests.access?.[key];
    assert.equal(typeof rule, "function");
    if (typeof rule === "function") {
      assert.equal(await rule({ req: { user: null } } as never), false);
    }
  }
});

test("contact requests have clear admin labels and source", () => {
  assert.equal(ContactRequests.admin?.group, "Маркетинг");
  assert.equal(ContactRequests.labels?.plural, "Обращения с сайта");
  const source = ContactRequests.fields.find((field) => "name" in field && field.name === "source");
  assert.ok(source && "defaultValue" in source);
  assert.equal(source.defaultValue, "landing-contact");
});

test("contact requests migration contains schema, rollback and registration", () => {
  const root = path.join(__dirname, "..");
  const migration = fs.readFileSync(path.join(root, "migrations/20261128_120000_contact_requests.ts"), "utf8");
  const index = fs.readFileSync(path.join(root, "migrations/index.ts"), "utf8");
  for (const marker of [
    'CREATE TABLE IF NOT EXISTS "contact_requests"',
    '"message" varchar NOT NULL',
    '"consent" boolean NOT NULL',
    '"source" varchar DEFAULT \'landing-contact\'',
    'ADD COLUMN IF NOT EXISTS "contact_requests_id"',
    'DROP TABLE IF EXISTS "contact_requests"',
  ]) assert.ok(migration.includes(marker), `Missing migration marker: ${marker}`);
  assert.ok(index.includes("20261128_120000_contact_requests"));
});
