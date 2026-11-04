import { NextRequest, NextResponse } from "next/server"
import { readAvatar } from "@/lib/avatar-storage"

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ filename: string }> }
) {
  const { filename } = await params

  try {
    const file = await readAvatar(filename)
    if (!file) return new NextResponse(null, { status: 404 })

    return new NextResponse(new Uint8Array(file.bytes), {
      headers: {
        "Content-Type": file.contentType,
        "Cache-Control": "public, max-age=3600",
      },
    })
  } catch {
    return new NextResponse(null, { status: 404 })
  }
}
