import { NextRequest, NextResponse } from "next/server"
import { getPayload } from "payload"
import { z } from "zod"
import configPromise from "@payload-config"

const questionSchema = z.object({
  question: z.string().trim().min(10, "Опишите вопрос чуть подробнее").max(1000),
  name: z.string().trim().min(2, "Укажите имя").max(120),
  email: z.string().trim().email("Укажите корректный email").max(254),
  consent: z.literal(true, { error: "Подтвердите согласие на обработку персональных данных" }),
})

export async function POST(request: NextRequest) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Некорректные данные формы" }, { status: 400 })
  }

  const parsed = questionSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message || "Проверьте данные формы" }, { status: 400 })
  }

  try {
    const payload = await getPayload({ config: configPromise })
    await payload.create({
      collection: "faqs",
      overrideAccess: true,
      data: {
        question: parsed.data.question,
        name: parsed.data.name || undefined,
        email: parsed.data.email || undefined,
        source: "website",
        status: "pending",
      },
    })
    return NextResponse.json({ success: true })
  } catch (error) {
    console.error("[faq] create failed", error)
    return NextResponse.json({ error: "Не удалось отправить вопрос. Попробуйте ещё раз." }, { status: 500 })
  }
}
