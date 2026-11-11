// ВРЕМЕННЫЙ мост МойСклад → КофеСклад: раз в час переносит статусы и оплаты
// заказов 10C-* и отгрузки МойСклад. Нужен, пока в КофеСклад нет остатков,
// приходов и техкарт и отгрузки ведутся в МойСклад.
// УБРАТЬ после полной настройки КофеСклад вместе с эндпоинтом /api/public/ms-sync.
//
// Payload не используется (чистый HTTP МойСклад → КофеСклад), поэтому мост
// работает в основном процессе сайта без отдельного воркера.

const MS_BASE = "https://api.moysklad.ru/api/remap/1.2"
const BRIDGE_INTERVAL_MS = 60 * 60_000 // 1 час
const BRIDGE_RETRY_MS = 5 * 60_000

function readEnabled(value) {
  return ["1", "true", "yes", "on"].includes((value || "").toLowerCase())
}

// Статус МойСклад → статус заказа КофеСклад
function mapMsStateToCsStatus(stateName) {
  const s = (stateName || "").trim().toLowerCase().replace(/ё/g, "е")
  if (!s) return null
  if (s.includes("отмен")) return "cancelled"
  if (s.includes("возврат")) return "cancelled"
  if (s.includes("собран") || s.includes("готов")) return "assembled"
  if (s.includes("достав")) return "delivered"
  if (s.includes("отгруж")) return "shipped"
  if (s.includes("оплачен")) return "paid"
  if (s.includes("счет")) return "confirmed"
  if (s.includes("подтверж")) return "confirmed"
  if (s.includes("производ")) return "confirmed"
  if (s.includes("нов")) return "new"
  return null
}

function msAuthHeader(env) {
  if (env.MOYSKLAD_TOKEN) return `Bearer ${env.MOYSKLAD_TOKEN}`
  return "Basic " + Buffer.from(`${env.MOYSKLAD_LOGIN}:${env.MOYSKLAD_PASSWORD}`).toString("base64")
}

async function msFetch(path, env) {
  const url = path.startsWith("http") ? path : `${MS_BASE}/${path.replace(/^\/+/, "")}`
  let lastError
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: msAuthHeader(env), Accept: "application/json;charset=utf-8" },
        signal: AbortSignal.timeout(30_000),
      })
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`МойСклад HTTP ${res.status}`)
        await new Promise((r) => setTimeout(r, 2000 * attempt))
        continue
      }
      if (!res.ok) throw new Error(`МойСклад HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`)
      return await res.json()
    } catch (error) {
      lastError = error
      if (attempt < 3) await new Promise((r) => setTimeout(r, 2000 * attempt))
    }
  }
  throw lastError
}

async function msFetchAll(path, env) {
  const rows = []
  let offset = 0
  while (true) {
    const sep = path.includes("?") ? "&" : "?"
    const page = await msFetch(`${path}${sep}limit=1000&offset=${offset}`, env)
    rows.push(...(page.rows || []))
    const size = page.meta?.size || rows.length
    if (rows.length >= size || !(page.rows || []).length) break
    offset += 1000
  }
  return rows
}

function metaId(entity) {
  const href = entity?.meta?.href || ""
  return href ? href.split("/").pop() : ""
}

function splitMoment(moment) {
  // МойСклад отдаёт локальное (московское) время аккаунта: "2026-11-10 14:30:00.000"
  const m = String(moment || "")
  return { date: m.slice(0, 10), time: m.slice(11, 16) }
}

async function postMsSync(csBase, csKey, payload) {
  const res = await fetch(`${csBase}/api/public/ms-sync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": csKey },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`КофеСклад ms-sync HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`)
  return body
}

export async function runMoyskladCoffeeskladBridge({ env = process.env, logger = console } = {}) {
  const csBase = (env.COFFESKLAD_URL || "").replace(/\/+$/, "")
  const csKey = env.COFFESKLAD_API_KEY || ""
  if (!readEnabled(env.MOYSKLAD_ENABLED) || !(env.MOYSKLAD_TOKEN || (env.MOYSKLAD_LOGIN && env.MOYSKLAD_PASSWORD))) {
    return { ok: false, skipped: true, reason: "МойСклад не настроен" }
  }
  if (!readEnabled(env.COFFESKLAD_ENABLED) || !csBase || !csKey) {
    return { ok: false, skipped: true, reason: "КофеСклад не настроен" }
  }

  // 1. Заказы 10C-* (статус по состоянию МС, оплата по payedSum)
  const msOrders = await msFetchAll("entity/customerorder?filter=name~=10C-&expand=state", env)
  const orderNameById = new Map()
  const orders = []
  for (const o of msOrders) {
    if (!o.name) continue
    orderNameById.set(o.id || metaId(o), o.name)
    orders.push({
      number: o.name,
      status: mapMsStateToCsStatus(o.state?.name),
      paid: (Number(o.payedSum) || 0) / 100,
    })
  }

  // 2. Отгрузки МС (без expand: на выборках >100 строк МойСклад молча
  // игнорирует expand). Позиции и контрагента дотягиваем только для новых.
  const msDemands = await msFetchAll("entity/demand", env)
  const demandByName = new Map()
  const sales = []
  for (const d of msDemands) {
    if (!d.name) continue
    demandByName.set(d.name, d)
    const { date, time } = splitMoment(d.moment)
    const orderNumber = orderNameById.get(metaId(d.customerOrder)) || ""
    sales.push({
      external_id: d.name,
      date,
      time,
      paid: (Number(d.payedSum) || 0) / 100,
      sum: (Number(d.sum) || 0) / 100,
      order_number: orderNumber,
      customer: { name: d.agent?.name || "", inn: d.agent?.inn || "" },
    })
  }

  // 3. Первый проход: обновить существующее, собрать sales_needed
  const first = await postMsSync(csBase, csKey, { orders, sales })
  logger.log(`[MS→CS bridge] заказы: обновлено ${first.orders_updated}, без пары ${first.orders_unknown.length}; ` +
    `отгрузки: обновлено ${first.sales_updated}, помечено ${first.sales_tagged}, нужны позиции ${first.sales_needed.length}`)
  for (const n of first.orders_unknown || []) logger.warn(`[MS→CS bridge] заказ ${n} есть в МойСклад, но нет в КофеСклад`)
  for (const w of first.warnings || []) logger.warn(`[MS→CS bridge] ${w}`)

  // 4. Для неизвестных отгрузок дотягиваем позиции и создаём их в КофеСклад
  let created = 0
  const needed = (first.sales_needed || []).filter((name) => demandByName.has(name))
  if (needed.length) {
    const withLines = []
    for (const name of needed) {
      const d = demandByName.get(name)
      const demandId = d.id || metaId(d)
      // Полный документ с контрагентом + позиции с номенклатурой
      // (expand на одиночном документе работает, в отличие от списка).
      const [full, positions] = await Promise.all([
        msFetch(`entity/demand/${demandId}?expand=agent`, env),
        msFetchAll(`entity/demand/${demandId}/positions?expand=assortment`, env),
      ])
      const src = { ...sales.find((s) => s.external_id === name) }
      src.customer = { name: full.agent?.name || "", inn: full.agent?.inn || "" }
      src.lines = positions.map((p) => ({
        code: p.assortment?.code || p.assortment?.article || "",
        name: p.assortment?.name || "",
        qty: Number(p.quantity) || 0,
        price: (Number(p.price) || 0) / 100,
        vat_rate: p.vat == null ? 22 : Number(p.vat),
      }))
      withLines.push(src)
    }
    const second = await postMsSync(csBase, csKey, { orders: [], sales: withLines })
    created = second.sales_created || 0
    logger.log(`[MS→CS bridge] создано отгрузок: ${created}`)
    for (const w of second.warnings || []) logger.warn(`[MS→CS bridge] ${w}`)
  }

  return { ok: true, ordersUpdated: first.orders_updated, salesUpdated: first.sales_updated, salesTagged: first.sales_tagged, salesCreated: created }
}

export function startMoyskladCoffeeskladBridge({
  env = process.env,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  logger = console,
} = {}) {
  if (!readEnabled(env.MOYSKLAD_ENABLED) || !readEnabled(env.COFFESKLAD_ENABLED)) {
    logger.log("[MS→CS bridge] disabled: нужны MOYSKLAD_ENABLED и COFFESKLAD_ENABLED")
    return () => {}
  }
  let stopped = false
  let timer
  const run = async () => {
    if (stopped) return
    let delay = BRIDGE_INTERVAL_MS
    try {
      logger.log("[MS→CS bridge] starting sync")
      const result = await runMoyskladCoffeeskladBridge({ env, logger })
      if (result.ok) logger.log("[MS→CS bridge] sync completed")
      else logger.warn(`[MS→CS bridge] skipped: ${result.reason || "?"}`)
    } catch (error) {
      if (!stopped) logger.error("[MS→CS bridge]", error instanceof Error ? error.message : "bridge failed")
      delay = BRIDGE_RETRY_MS
    } finally {
      if (!stopped) timer = setTimer(run, delay)
    }
  }
  logger.log("[MS→CS bridge] enabled: first sync in 2 minutes; interval 1 hour after completion (ВРЕМЕННЫЙ мост)")
  timer = setTimer(run, 120_000)
  return () => {
    stopped = true
    clearTimer(timer)
  }
}
