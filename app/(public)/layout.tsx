import { Suspense } from "react"
import type { Metadata } from "next"
import { HtmlWrapper } from "@/components/shared/html-wrapper"
import { AuthModal } from "@/components/auth/auth-modal"
import { getSiteSettings } from "@/lib/actions/site-settings"
import { AuthProvider } from "@/providers/auth-provider"
import "@/components/landing/_shared/landing-globals.css"

export const metadata: Metadata = {
  title: "Оптовые поставки кофе по всей России - 10coffee",
}

const organizationJsonLd = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "10coffee",
  url: "https://10coffee.ru",
  logo: "https://10coffee.ru/logo.svg",
  email: "10coffee@mail.ru",
  telephone: ["+7 (938) 453-70-60", "+7 (918) 401-70-60"],
  address: {
    "@type": "PostalAddress",
    addressLocality: "Сочи",
    streetAddress: "ул. Пластунская, 79/1, пом. 1",
    addressCountry: "RU",
  },
  sameAs: [
    "https://t.me/Tencoffeesochi",
    "https://vk.com/10coffee",
    "https://www.instagram.com/10coffee.ru",
  ],
}).replace(/</g, "\\u003c")

export default async function PublicLayout({
  children,
}: {
  children: React.ReactNode
}) {
  let announcement: string | null = null
  try {
    const settings = await getSiteSettings()
    if (settings?.loginAnnouncementEnabled && settings?.loginAnnouncement) {
      announcement = settings.loginAnnouncement
    }
  } catch {
    // Settings not yet initialized — skip
  }

  return (
    <HtmlWrapper>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: organizationJsonLd }} />
      <AuthProvider sessionScope="business">
        <div className="landing-scope">
          {children}
        </div>
      </AuthProvider>

      <Suspense fallback={null}>
        <AuthModal announcement={announcement} customerType="business" />
      </Suspense>
    </HtmlWrapper>
  )
}
