import path from "path"
import { buildConfig } from "payload"
import { postgresAdapter } from "@payloadcms/db-postgres"
import { FixedToolbarFeature, HeadingFeature, lexicalEditor } from "@payloadcms/richtext-lexical"
import { s3Storage } from "@payloadcms/storage-s3"
import { ru } from "@payloadcms/translations/languages/ru"
import type { EmailAdapter, SendEmailOptions } from "payload"
import { createSmtpTransport } from "./lib/email/smtp"
import sharp from "sharp"

import { Categories } from "./payload/collections/Categories"
import { ProductTypes } from "./payload/collections/ProductTypes"
import { Products } from "./payload/collections/Products"
import { ProductReviews } from "./payload/collections/ProductReviews"
import { Orders } from "./payload/collections/Orders"
import { PromoCodes } from "./payload/collections/PromoCodes"
import { News } from "./payload/collections/News"
import { Admins } from "./payload/collections/Admins"
import { Clients } from "./payload/collections/Clients"
import { Media } from "./payload/collections/Media"
import { CartItems } from "./payload/collections/CartItems"
import { Favorites } from "./payload/collections/Favorites"
import { MapLocations } from "./payload/collections/MapLocations"
import { BlogPosts } from "./payload/collections/BlogPosts"
import { CoffeeBrewingGuides } from "./payload/collections/CoffeeBrewingGuides"
import { Tags } from "./payload/collections/Tags"
import { PriceListRequests } from "./payload/collections/PriceListRequests"
import { Faqs } from "./payload/collections/Faqs"
import { SiteSettings } from "./payload/globals/SiteSettings"
import { PaymentSettings } from "./payload/globals/PaymentSettings"
import { LoyaltySettings } from "./payload/globals/LoyaltySettings"
import { DeliverySettings } from "./payload/globals/DeliverySettings"
import { ShopPopupSettings } from "./payload/globals/ShopPopupSettings"
import { ShopTickerSettings } from "./payload/globals/ShopTickerSettings"
import { LoyaltyOperations } from "./payload/collections/LoyaltyOperations"
import { JobApplications } from "./payload/collections/JobApplications"
import { JobApplicationFiles } from "./payload/collections/JobApplicationFiles"
import { businessDashboardHandler } from "./payload/endpoints/businessDashboard"
import { adminUnreadCountsHandler } from "./payload/endpoints/adminUnreadCounts"

function requiredEnv(name: "DATABASE_URL" | "PAYLOAD_SECRET"): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

const databaseUrl = requiredEnv("DATABASE_URL")
const payloadSecret = requiredEnv("PAYLOAD_SECRET")

const smtpEmailAdapter: EmailAdapter = () => {
  const defaultFromAddress = process.env.SMTP_EMAIL || "noreply@10coffee.ru"
  const transporter = createSmtpTransport()

  return {
    name: "smtp",
    defaultFromAddress,
    defaultFromName: "10coffee",
    sendEmail: (message: SendEmailOptions) =>
      transporter.sendMail({
        ...message,
        from: message.from || `"10coffee" <${defaultFromAddress}>`,
      }),
  }
}

export default buildConfig({
  serverURL: process.env.NEXT_PUBLIC_SERVER_URL || "",

  admin: {
    user: Admins.slug,
    meta: {
      titleSuffix: " — 10coffee",
      description: "Панель управления 10coffee",
    },
    dateFormat: "dd.MM.yyyy HH:mm",
    components: {
      header: ["/payload/components/AdminWorkspaceSwitcher"],
      beforeDashboard: ["/payload/components/BusinessDashboard"],
    },
  },

  collections: [
    Orders,
    PriceListRequests,
    JobApplications,
    Faqs,
    PromoCodes,
    Clients,
    LoyaltyOperations,
    CartItems,
    Favorites,
    Tags,
    ProductTypes,
    Products,
    ProductReviews,
    Categories,
    News,
    MapLocations,
    BlogPosts,
    CoffeeBrewingGuides,
    JobApplicationFiles,
    Media,
    Admins,
  ],

  globals: [SiteSettings, PaymentSettings, LoyaltySettings, DeliverySettings, ShopPopupSettings, ShopTickerSettings],

  editor: lexicalEditor({
    admin: {
      placeholder: "Добавьте описание: заголовки, жирный текст, списки, ссылки...",
    },
    features: ({ defaultFeatures }) => [
      ...defaultFeatures.map((feature) =>
        feature.key === "heading"
          ? HeadingFeature({ enabledHeadingSizes: ["h1", "h2", "h3", "h4", "h5", "h6"] })
          : feature
      ),
      FixedToolbarFeature(),
    ],
  }),

  email: smtpEmailAdapter,

  secret: payloadSecret,

  endpoints: [
    {
      path: "/admin-unread-counts",
      method: "get",
      handler: adminUnreadCountsHandler,
    },
    {
      path: "/business-dashboard",
      method: "get",
      handler: businessDashboardHandler,
    },
  ],

  typescript: {
    outputFile: path.resolve(__dirname, "payload-types.ts"),
  },

  db: postgresAdapter({
    pool: {
      connectionString: databaseUrl,
    },
    // Database changes must be an explicit deployment step. Initializing
    // Payload during `next build` or a page request must stay read-only.
    push: process.env.NODE_ENV !== "production" && process.env.PAYLOAD_DB_PUSH === "true",
  }),

  sharp,

  plugins: [
    s3Storage({
      collections: {
        media: { prefix: "media/" },
        "job-application-files": { prefix: "job-applications/" },
      },
      bucket: process.env.S3_BUCKET || "placeholder",
      config: {
        endpoint: process.env.S3_ENDPOINT,
        credentials: {
          accessKeyId: process.env.S3_ACCESS_KEY_ID || "",
          secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "",
        },
        region: process.env.S3_REGION || "us-east-1",
        forcePathStyle: true,
      },
      ...(process.env.S3_BUCKET ? {} : { enabled: false }),
    }),
  ],

  localization: {
    locales: [{ label: "Русский", code: "ru" }],
    defaultLocale: "ru",
  },

  i18n: {
    supportedLanguages: { ru },
    fallbackLanguage: "ru",
  },
})
