// Конфигурация интеграции сайта с КофеСклад (учёт обжарочного производства).
// КофеСклад — локальный сервер учёта: принимает заказы через публичный webhook
// POST /api/public/order с ключом x-api-key.

export interface CoffeeskladConfig {
  enabled: boolean
  baseUrl: string
  apiKey: string
}

function readBoolean(value: string | undefined, defaultValue = false) {
  if (value === undefined || value === "") return defaultValue
  return ["1", "true", "yes", "on"].includes(value.toLowerCase())
}

export function getCoffeeskladConfig(): CoffeeskladConfig {
  return {
    enabled: readBoolean(process.env.COFFESKLAD_ENABLED, false),
    baseUrl: (process.env.COFFESKLAD_URL || "http://localhost:7100").replace(/\/+$/, ""),
    apiKey: process.env.COFFESKLAD_API_KEY || "",
  }
}

export function isCoffeeskladReady(config = getCoffeeskladConfig()) {
  return config.enabled && Boolean(config.apiKey)
}
