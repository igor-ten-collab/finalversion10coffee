import type { NextConfig } from "next"
import { withPayload } from "@payloadcms/next/withPayload"

function remoteImagePattern(rawUrl: string | undefined) {
  if (!rawUrl) return null
  try {
    const url = new URL(rawUrl)
    if (url.protocol !== "http:" && url.protocol !== "https:") return null
    return {
      protocol: url.protocol.replace(":", "") as "http" | "https",
      hostname: url.hostname,
      port: url.port,
      pathname: "/**",
    }
  } catch {
    return null
  }
}

const remoteImagePatterns = [
  process.env.NEXT_PUBLIC_SERVER_URL,
  process.env.NEXT_PUBLIC_SITE_URL,
  process.env.COOLIFY_URL,
  process.env.S3_ENDPOINT,
]
  .map(remoteImagePattern)
  .filter((pattern): pattern is NonNullable<typeof pattern> => Boolean(pattern))
  .filter(
    (pattern, index, patterns) =>
      patterns.findIndex(
        (item) =>
          item.protocol === pattern.protocol &&
          item.hostname === pattern.hostname &&
          item.port === pattern.port
      ) === index
  )

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-DNS-Prefetch-Control", value: "on" },
]

const longCacheHeaders = [
  { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
]

const nextConfig: NextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    // Next.js 16.3 rejects local image query strings by default. Payload S3
    // includes this fixed public-media prefix in its generated file URLs.
    localPatterns: [
      { pathname: "/**", search: "" },
      { pathname: "/api/media/file/**", search: "?prefix=media%2F" },
    ],
    remotePatterns: remoteImagePatterns,
    formats: ["image/avif", "image/webp"],
    minimumCacheTTL: 60 * 60 * 24 * 30,
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "100mb",
    },
    proxyClientMaxBodySize: "100mb",
  },
  async redirects() {
    return [
      { source: "/login", destination: "/?auth=login", permanent: false },
      { source: "/register", destination: "/?auth=register", permanent: false },
      { source: "/forgot-password", destination: "/?auth=forgot", permanent: false },
    ]
  },
  async headers() {
    return [
      {
        source: "/:path*.mp4",
        headers: longCacheHeaders,
      },
      {
        source: "/media/:path*",
        headers: longCacheHeaders,
      },
      {
        source: "/uploads/:path*",
        headers: longCacheHeaders,
      },
      {
        source: "/api/media/file/:path*",
        headers: longCacheHeaders,
      },
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ]
  },
}

export default withPayload(nextConfig)
