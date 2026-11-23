import { type NextRequest, NextResponse } from "next/server"
import { updateSession } from "@/lib/supabase/middleware"

function normalizeIp(value: string | null) {
  return value?.trim().replace(/^::ffff:/, "") || ""
}

function getClientIp(request: NextRequest) {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0] || null
  return normalizeIp(
    request.headers.get("cf-connecting-ip") ||
      request.headers.get("x-real-ip") ||
      forwardedFor
  )
}

function getHostname(request: NextRequest) {
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]
  return (forwardedHost || request.headers.get("host") || "")
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "")
}

function isShopPreviewAllowed(request: NextRequest) {
  // Closing the shop from search engines (robots/noindex) must not make it
  // unavailable to real visitors. Access restriction is therefore opt-in and
  // only enabled by an explicit operational flag.
  if (process.env.SHOP_RESTRICT_ACCESS !== "true") return true
  if (process.env.NODE_ENV !== "production") return true

  const allowedIps = (process.env.SHOP_ALLOWED_IPS || "")
    .split(",")
    .map(normalizeIp)
    .filter(Boolean)

  return allowedIps.includes(getClientIp(request))
}

const MAIN_SITE_CONTENT_PATHS = [
  "/news",
  "/blog",
  "/contacts",
  "/delivery",
  "/return",
  "/faq",
  "/oferta",
  "/loyalty",
  "/o-nas",
  "/kontakty",
  "/obuchenie",
  "/b2b-servis",
  "/vakansii",
]

function isMainSiteContentPath(pathname: string) {
  return MAIN_SITE_CONTENT_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))
}

// Shop catalog pages have one canonical host: shop.10coffee.ru. The same app
// also answers on 10coffee.ru, so without this redirect every product and
// category exists twice for search engines.
const SHOP_CATALOG_PATHS = ["/shop", "/kofe", "/chay", "/aksessuary", "/khimiya", "/himiya"]

function isShopCatalogPath(pathname: string) {
  return SHOP_CATALOG_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))
}

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname
  const hostname = getHostname(request)
  const isShopHost = hostname === "shop.10coffee.ru" || hostname.startsWith("shop.localhost")
  const isShopPath = pathname === "/shop" || pathname.startsWith("/shop/") || pathname === "/main" || pathname.startsWith("/main/") || pathname === "/checkout" || pathname.startsWith("/order/")
  const isPaymentWebhook = pathname === "/api/shop/payments/yookassa/webhook"

  // Public editorial and reference pages have one canonical host. Keeping
  // this at the host-routing layer prevents duplicate shop.* URLs regardless
  // of which header, footer or external link the visitor used.
  if (hostname === "shop.10coffee.ru" && isMainSiteContentPath(pathname)) {
    const url = request.nextUrl.clone()
    url.protocol = "https:"
    url.hostname = "10coffee.ru"
    url.port = ""
    return NextResponse.redirect(url, 308)
  }

  // Mirror of the rule above: catalog URLs on the main domain are duplicates.
  if ((hostname === "10coffee.ru" || hostname === "www.10coffee.ru") && isShopCatalogPath(pathname)) {
    const url = request.nextUrl.clone()
    url.protocol = "https:"
    url.hostname = "shop.10coffee.ru"
    url.port = ""
    return NextResponse.redirect(url, 308)
  }

  if ((isShopHost || isShopPath) && !isPaymentWebhook && !isShopPreviewAllowed(request)) {
    return new NextResponse("Страница временно недоступна", {
      status: 404,
      headers: { "Cache-Control": "private, no-store" },
    })
  }

  if (isShopHost && pathname === "/") {
    const url = request.nextUrl.clone()
    url.pathname = "/shop"
    return NextResponse.rewrite(url)
  }

  // Skip Payload admin and API routes — Payload handles its own auth
  if (pathname.startsWith("/admin") || pathname.startsWith("/api")) {
    return NextResponse.next()
  }

  return await updateSession(request)
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
}
