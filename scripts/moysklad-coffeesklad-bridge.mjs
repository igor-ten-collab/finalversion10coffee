// МОСТ ОТКЛЮЧЁН 12.11.2026 по решению Игоря: суммы/оплаты/статусы с МС сошлись,
// дальше статусы и оплаты ведутся вручную в КофеСклад. Заказы с сайта приходят
// в КС напрямую через вебхук. Оригинал: moysklad-coffeesklad-bridge.mjs.bak
export async function runMoyskladCoffeeskladBridge({ logger = console } = {}) {
  logger.log("[MS→CS bridge] отключён (stub)")
  return { ok: false, skipped: true, reason: "мост отключён" }
}
export function startMoyskladCoffeeskladBridge({ logger = console } = {}) {
  logger.log("[MS→CS bridge] отключён (stub), фоновая синхронизация не запускается")
}
