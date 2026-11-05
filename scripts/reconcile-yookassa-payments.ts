import { preparePayloadRuntime } from "./payload-runtime"

async function main() {
  preparePayloadRuntime()
  const [{ getYooKassaConfig, isYooKassaReady }, { reconcilePendingYooKassaPayments }] = await Promise.all([
    import("../lib/payments/yookassa"),
    import("../lib/payments/yookassa-order-status"),
  ])
  const config = await getYooKassaConfig()
  if (!config.enabled) {
    console.log("[YooKassa reconciliation] payments disabled in effective settings; skipped")
    return
  }
  if (!isYooKassaReady(config)) throw new Error("PAYMENT_CONFIGURATION_INCOMPLETE")
  const result = await reconcilePendingYooKassaPayments()
  console.log("[YooKassa reconciliation]", JSON.stringify(result))
  if (result.errors.length) process.exitCode = 1
}

main().catch(error => {
  // Never serialize provider configuration or request headers.
  console.error("[YooKassa reconciliation] worker failed:", error instanceof Error ? error.message : "UNKNOWN_ERROR")
  process.exitCode = 1
}).finally(() => process.exit(process.exitCode || 0))
