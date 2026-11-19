import { NextResponse, type NextRequest } from "next/server"
import { getPayload } from "payload"
import configPromise from "@payload-config"
import { cancelOrderInCoffeesklad, type CoffeeskladCancelAction } from "@/lib/coffeesklad/cancel"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Ручной повтор отмены/восстановления заказа в КофеСклад.
// Доступ: только админ Payload (JWT) либо CRON_SECRET — как у /api/coffeesklad/sync.
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
  const body = await request.json().catch(() => null) as {
    orderId?: string | number
    action?: string
  } | null
  if (!body?.orderId) {
    return NextResponse.json({ ok: false, error: "Укажите orderId" }, { status: 400 })
  }
  const action: CoffeeskladCancelAction = body.action === "restore" ? "restore" : "cancel"

  let order: { id: string | number; orderId?: string | null }
  try {
    order = await payload.findByID({
      collection: "orders",
      id: body.orderId,
      depth: 0,
      overrideAccess: true,
    })
  } catch {
    return NextResponse.json({ ok: false, error: "Заказ не найден" }, { status: 404 })
  }

  const result = await cancelOrderInCoffeesklad(payload, order, action)
  return NextResponse.json({ ok: !result.error, ...result }, { status: result.error ? 502 : 200 })
}
