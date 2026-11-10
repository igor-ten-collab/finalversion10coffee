// Импорт каталога КофеСклад → сайт 10coffee (Payload CMS).
// Идемпотентен: повторный запуск обновляет цены/артикулы, не создавая дублей.
// Запуск: node scripts/import-coffeesklad-catalog.mjs
//
// Что делает:
//  1. Забирает продаваемые позиции из КофеСклад (GET /api/public/catalog).
//  2. Создаёт типы товаров (coffee/tea/equipment), категории и товары с вариантами.
//  3. Артикул варианта (sku) = штрихкод EAN-13 зерновой фасовки КофеСклад,
//     skuGround = штрихкод молотой фасовки — по ним заказы сайта попадают в учёт.

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const envFile = path.join(__dirname, "..", ".env")
const env = {}
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) env[m[1]] = m[2]
  }
}

const COFFESKLAD_URL = (process.env.COFFESKLAD_URL || env.COFFESKLAD_URL || "http://localhost:7100").replace(/\/+$/, "")
const COFFESKLAD_API_KEY = process.env.COFFESKLAD_API_KEY || env.COFFESKLAD_API_KEY || ""
const SITE_URL = (process.env.SITE_URL || "http://localhost:3000").replace(/\/+$/, "")
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@10coffee.ru"
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Coffee2026!"

if (!COFFESKLAD_API_KEY) {
  console.error("Не задан COFFESKLAD_API_KEY (см. .env)")
  process.exit(1)
}

// ---------- утилиты ----------
const TRANSLIT = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
  й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
  у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "",
  э: "e", ю: "yu", я: "ya", "№": "o",
}
function slugify(value) {
  return value.toLowerCase().split("").map((ch) => TRANSLIT[ch] ?? ch).join("")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "item"
}
function weightLabel(kg) {
  if (kg == null) return null
  if (kg >= 1 && Number.isInteger(kg)) return `${kg} кг`
  return `${Math.round(kg * 1000)} г`
}
function normalizeGroup(group) {
  const parts = String(group || "").split("/").map((s) => s.trim()).filter(Boolean)
  return { typeName: parts[0] || "", categoryName: parts[1] || parts[0] || "Прочее" }
}
const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s)

// Явная привязка позиций КофеСклад к существующим товарам сайта,
// у которых slug отличается от генерируемого (исторические названия с весом,
// slug длиннее 80 символов). Иначе импорт создавал бы дубли на витрине.
const SLUG_OVERRIDES = new Map([
  ["Ассам (TGFOP)", "assam-tgfop-500g"],
  ["Гречишный чай Ку Цяо", "grechishnyy-chay-ku-tsyao-500g"],
  ["Матча Премиум", "matcha-premium-250g"],
  ["Молочный Улун", "molochnyy-ulun-500g"],
  ["Сенча", "sencha-500g"],
  ["Те Гуань Инь", "te-guan-in-500g"],
  ["Чай Конопляный Пуэр", "chay-konoplyanyy-puer-500g"],
  ["Чай Спокойствие", "chay-spokoystvie-500g"],
  ["Чай Травяной", "chay-travyanoy-500g"],
  ["Эрл Грей", "erl-grey-500g"],
  ["кофемашина Appia Life Compact 2Gr V 220V black+economizer+high groups Кофемашина-автомат, 2 группы (выс.), бойлер 7.5л, черная, экономайзер",
   "kofemashina-appia-life-compact-2gr-v-220v-black-economizer-high-groups-kofemashina-avtomat-2-gruppy-vys-boyler-7-5l-chernaya-ekonomayzer"],
])

// ---------- загрузка каталога КофеСклад ----------
const catalogRes = await fetch(`${COFFESKLAD_URL}/api/public/catalog`, {
  headers: { "x-api-key": COFFESKLAD_API_KEY },
})
if (!catalogRes.ok) {
  console.error(`КофеСклад недоступен: HTTP ${catalogRes.status}`)
  process.exit(1)
}
const { items } = await catalogRes.json()
console.log(`КофеСклад: получено позиций: ${items.length}`)

// ---------- сборка модели сайта ----------
// productType: Кофе → coffee, Чай → tea, остальное → equipment
const TYPE_MAP = {
  "кофе": { slug: "coffee", name: "Кофе", detailsSchema: "coffee" },
  "чай": { slug: "tea", name: "Чай", detailsSchema: "tea" },
}
const DEFAULT_TYPE = { slug: "equipment", name: "Оборудование и аксессуары", detailsSchema: "generic" }

// группируем фасовки по продуктам
const products = new Map() // key → { name, type, categoryName, variants: Map(weightLabel → {sku, skuGround, price, weightGrams, ground}) }
for (const item of items) {
  // На сайт попадают только позиции со штрихкодом: без штрихкода — это услуги,
  // запчасти и прочая учётная номенклатура, витрине она не нужна.
  if (!item.barcode) continue
  const { typeName, categoryName } = normalizeGroup(item.group_name)
  const type = TYPE_MAP[typeName.toLowerCase()] || DEFAULT_TYPE

  let productName, variantWeightLabel, weightGrams, isGround = false
  if (item.base_name) {
    // кофейная фасовка: имя базы без служебного суффикса
    productName = item.base_name.replace(/\s*\(базовый\)\s*$/i, "").trim()
    variantWeightLabel = weightLabel(item.pack_weight_kg)
    weightGrams = item.pack_weight_kg != null ? Math.round(item.pack_weight_kg * 1000) : null
    isGround = /молотый$/i.test(item.name)
  } else {
    // одиночная позиция (чай, оборудование): отрезаем вес из названия
    const m = item.name.match(/^(.*?)[\s,]*(\d+(?:[.,]\d+)?)\s*(кг|г)\.?$/u)
    if (m && item.pack_weight_kg) {
      productName = m[1].trim()
      variantWeightLabel = weightLabel(item.pack_weight_kg)
      weightGrams = Math.round(item.pack_weight_kg * 1000)
    } else {
      productName = item.name
      variantWeightLabel = "шт"
      weightGrams = null
    }
  }

  const key = `${type.slug}|${productName}`
  if (!products.has(key)) {
    products.set(key, { name: productName, type, categoryName, variants: new Map() })
  }
  const product = products.get(key)
  const vKey = variantWeightLabel || "шт"
  if (!product.variants.has(vKey)) {
    product.variants.set(vKey, { name: vKey, weightGrams, sku: "", skuGround: "", price: null, hasGround: false })
  }
  const variant = product.variants.get(vKey)
  if (isGround) {
    variant.skuGround = item.barcode || ""
    variant.hasGround = true
    if (variant.price == null && item.price != null) variant.price = item.price
  } else {
    variant.sku = item.barcode || variant.sku
    if (item.price != null) variant.price = item.price
  }
}

// ---------- авторизация в Payload ----------
const loginRes = await fetch(`${SITE_URL}/api/admins/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
})
if (!loginRes.ok) {
  console.error(`Не удалось войти в админку сайта: HTTP ${loginRes.status}`, await loginRes.text())
  process.exit(1)
}
const { token } = await loginRes.json()
const api = async (method, route, body) => {
  const res = await fetch(`${SITE_URL}/api/${route}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `JWT ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(`${method} /api/${route}: HTTP ${res.status} ${await res.text()}`)
  return res.json()
}

// ---------- существующие данные (идемпотентность) ----------
const existingTypes = new Map((await api("GET", "product-types?limit=100&depth=0")).docs.map((d) => [d.slug, d]))
const existingCategories = new Map((await api("GET", "categories?limit=500&depth=0")).docs.map((d) => [d.slug, d]))
const existingProducts = new Map((await api("GET", "products?limit=1000&depth=0")).docs.map((d) => [d.slug, d]))

async function ensureProductType(def) {
  const existing = existingTypes.get(def.slug)
  if (existing) return existing.id
  const created = await api("POST", "product-types", {
    name: def.name, slug: def.slug, detailsSchema: def.detailsSchema, isVisible: true,
  })
  existingTypes.set(def.slug, created.doc)
  console.log(`+ тип товара: ${def.name}`)
  return created.doc.id
}

async function ensureCategory(typeDef, categoryName, typeId) {
  const slug = slugify(categoryName)
  const existing = existingCategories.get(slug)
  if (existing) return existing.id
  const created = await api("POST", "categories", {
    name: categoryName, slug, productTypeRef: typeId, isVisible: true,
  })
  existingCategories.set(slug, created.doc)
  console.log(`+ категория: ${categoryName} (${typeDef.slug})`)
  return created.doc.id
}

// ---------- импорт ----------
let created = 0, updated = 0, skippedNoPrice = 0
for (const product of products.values()) {
  const typeId = await ensureProductType(product.type)
  const categoryId = await ensureCategory(product.type, capitalize(product.categoryName), typeId)
  const slug = SLUG_OVERRIDES.get(product.name) || slugify(product.name)
  // сортировка вариантов: сначала крупная фасовка
  const variants = [...product.variants.values()]
    .sort((a, b) => (b.weightGrams || 0) - (a.weightGrams || 0))
    .map((v) => ({
      name: v.name,
      sku: v.sku || undefined,
      skuGround: v.skuGround || undefined,
      price: v.price ?? 0,
      weightGrams: v.weightGrams ?? undefined,
      isAvailable: v.price != null && v.price > 0,
      grindOptions: product.type.slug === "coffee"
        ? (v.hasGround ? ["beans", "ground"] : ["beans"])
        : [],
    }))
  const anyPrice = variants.some((v) => v.isAvailable)
  if (!anyPrice) skippedNoPrice++
  const data = {
    name: product.name,
    slug,
    productTypeRef: typeId,
    category: categoryId,
    variants,
    isVisible: anyPrice, // без цен скрываем с витрины до назначения цен в КофеСклад
  }
  if (existingProducts.has(slug)) {
    const existing = existingProducts.get(slug)
    await api("PATCH", `products/${existing.id}`, data)
    updated++
  } else {
    await api("POST", "products", data)
    created++
    console.log(`+ товар: ${product.name} [${variants.map((v) => `${v.name}${v.sku ? "=" + v.sku : ""}${v.skuGround ? "+" + v.skuGround : ""} ${v.price ?? "—"}₽`).join(", ")}]${anyPrice ? "" : " (скрыт, нет цен)"}`)
  }
}

console.log(`\nГотово: создано ${created}, обновлено ${updated}, без цен (скрыты) ${skippedNoPrice}`)
