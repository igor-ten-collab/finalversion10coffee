const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const modalPath = path.join(root, "components/landing/ContactFormModal.tsx");
const footerPath = path.join(root, "components/landing/LandingFooter.tsx");

function read(file) {
  return fs.readFileSync(file, "utf8");
}

test("contact modal implements validated fields and accessible dialog behavior", () => {
  assert.ok(fs.existsSync(modalPath), "ContactFormModal.tsx is missing");
  const source = read(modalPath);
  for (const marker of [
    "useActionState",
    "submitContactRequest",
    'name="name"',
    'name="email"',
    'name="message"',
    'name="consent"',
    "<PhoneInput",
    'role="dialog"',
    'aria-modal="true"',
    'aria-labelledby="contact-form-title"',
    'event.key === "Escape"',
    'document.body.style.overflow = "hidden"',
    "onReset={() => setAgreed(false)}",
    "Сообщение сохранено. Мы свяжемся с вами по указанным контактам.",
  ]) assert.ok(source.includes(marker), `Missing modal contract: ${marker}`);
});

test("footer opens the contact modal instead of launching mailto", () => {
  const source = read(footerPath);
  assert.ok(source.includes('import ContactFormModal from "./ContactFormModal"'));
  assert.ok(source.includes("showContactModal"));
  assert.ok(source.includes('href="#contact-form"'));
  assert.ok(source.includes("setShowContactModal(true)"));
  assert.ok(source.includes("<ContactFormModal"));
  assert.ok(!source.includes('href="mailto:10coffee@mail.ru"'));
  assert.ok(source.includes("<PriceListFormModal"), "Price-list modal must remain wired");
});
