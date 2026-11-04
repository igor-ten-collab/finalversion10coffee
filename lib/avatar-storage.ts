import fs from "node:fs/promises"
import path from "node:path"
import crypto from "node:crypto"
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3"

export function isAvatarFilename(filename: string) {
  return /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.jpg$/i.test(filename)
}

function localDirectory() {
  return path.resolve(process.cwd(), "public/uploads/avatars")
}

function s3Storage() {
  const bucket = process.env.S3_BUCKET?.trim()
  if (!bucket) return null
  if (!process.env.S3_ACCESS_KEY_ID?.trim() || !process.env.S3_SECRET_ACCESS_KEY?.trim()) {
    throw Object.assign(new Error("Avatar S3 credentials are missing"), { code: "AVATAR_S3_CONFIG_MISSING" })
  }
  return {
    bucket,
    client: new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID!, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY! },
      region: process.env.S3_REGION || "us-east-1",
      forcePathStyle: true,
    }),
  }
}

export async function saveAvatar(filename: string, bytes: Buffer) {
  if (!isAvatarFilename(filename)) throw new Error("Invalid avatar filename")
  const storage = s3Storage()
  if (storage) {
    await storage.client.send(new PutObjectCommand({ Bucket: storage.bucket, Key: `avatars/${filename}`, Body: bytes, ContentType: "image/jpeg" }))
    return
  }
  const directory = localDirectory()
  await fs.mkdir(directory, { recursive: true })
  const temporary = path.join(directory, `.${filename}.${crypto.randomUUID()}.tmp`)
  let created = false
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx" })
    created = true
    await fs.rename(temporary, path.join(directory, filename))
  } finally {
    if (created) await fs.unlink(temporary).catch(() => {})
  }
}

export async function readAvatar(filename: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  if (!isAvatarFilename(filename)) return null
  const storage = s3Storage()
  if (storage) {
    try {
      const result = await storage.client.send(new GetObjectCommand({ Bucket: storage.bucket, Key: `avatars/${filename}` }))
      const bytes = await result.Body?.transformToByteArray()
      return bytes ? { bytes: Buffer.from(bytes), contentType: result.ContentType || "image/jpeg" } : null
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null
      throw error
    }
  }
  try {
    return { bytes: await fs.readFile(path.join(localDirectory(), filename)), contentType: "image/jpeg" }
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null
    throw error
  }
}
