import { NextResponse, type NextRequest } from "next/server"
import { getPayload } from "payload"
import configPromise from "@payload-config"
import { runCoffeeskladStatusSync } from "@/lib/coffeesklad/status-sync"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Ручной запуск обратной синхронизации КофеСклад → сайт.
// Плановая синхронизация идёт встроенным планировщиком
// (scripts/coffeesklad-status-scheduler.mjs), этот роут — для ручного вызова
// админом Payload (JWT) или с CRON_SECRET в Authorization.
async function isAuthorized(request: NextRequest, payload: Awaited<ReturnType<typeof getPayload>>) {
  const secret = process.env.CRON_SECRET
  if (secret && request.headers.get("authorization") === `Bearer ${secret}`) return true
  const { user } = await payload.auth({ headers: request.headers })
  return Boolean(user && user.collection === "admins")
}

export async function GET(request: NextRequest) {
  const payload = await getPayload({ config: configPromise })
  if (!(await isAuthorized(request, payload))) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 })
  }
  const result = await runCoffeeskladStatusSync(payload)
  return NextResponse.json(result)
}
