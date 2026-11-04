import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { saveAvatar } from "@/lib/avatar-storage"

export async function POST(req: NextRequest) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: "Не авторизован" }, { status: 401 })
    }

    const formData = await req.formData()
    const file = formData.get("file")

    if (!file || typeof file === "string") {
      return NextResponse.json({ error: "Файл не передан" }, { status: 400 })
    }

    if (file.type !== "image/jpeg" || file.size === 0 || file.size > 5 * 1024 * 1024) {
      return NextResponse.json({ error: "Выберите JPEG-изображение размером до 5 МБ" }, { status: 400 })
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    const fileName = `${user.id}.jpg`
    await saveAvatar(fileName, buffer)

    const url = `/api/avatar/${fileName}?t=${Date.now()}`

    return NextResponse.json({ url })
  } catch (error) {
    console.error("[avatar-upload]", { code: (error as { code?: string })?.code || "AVATAR_UPLOAD_FAILED" })
    return NextResponse.json({ error: "Не удалось сохранить аватар. Попробуйте позже." }, { status: 500 })
  }
}
