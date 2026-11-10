import { NextResponse, type NextRequest } from "next/server"
import { getPayload } from "payload"
import configPromise from "@payload-config"
import { syncOrderToCoffeeskladById } from "@/lib/coffeesklad/sync"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Повторная/ручная выгрузка заказа в КофеСклад.
// Доступ: только админ Payload (JWT) либо CRON_SECRET для фонового восстановления.
async function isAuthorized(request: NextRequest, payload: Awaited<ReturnType<typeof getPayload>>) {
  const secret = process.env.CRON_SECRET
  if (secret && request.headers.get("authorization") === `Bearer ${secret}`) return true
  const { user } = await payload.auth({ headers: request.headers })
  return Boolean(user && user.collection === "admins")
}

export async function POST(request: NextRequest) {
  const payload = await getPayload({ config: configPromise })
  if (!(await isAuthorized(request, payload))) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 })
  }
  const body = await request.json().catch(() => null) as { orderId?: string | number } | null
  if (!body?.orderId) {
    return NextResponse.json({ ok: false, error: "Укажите orderId" }, { status: 400 })
  }
  const result = await syncOrderToCoffeeskladById(payload, body.orderId)
  return NextResponse.json({ ok: !result.error, ...result }, { status: result.error ? 502 : 200 })
}
