import type { CollectionConfig } from "payload"
import { canManageOperations, canReadOperations, operationsDeleteAccess } from "../access/adminRoles"
import { promoWorkspaceBaseFilter } from "../admin/workspace"
import { randomBytes } from "crypto"
import { createSmtpTransport } from "@/lib/email/smtp"
import { PROMO_PRESETS } from "../promo-presets"

const smtpTransporter = createSmtpTransport()

function createPromoSuffix() {
  return randomBytes(3).toString("hex").toUpperCase()
}

function formatDiscount(discountType: "percentage" | "fixed_amount", discountValue: number) {
  return discountType === "percentage"
    ? `${discountValue}%`
    : `${discountValue.toLocaleString("ru-RU")} ₽`
}

async function sendIssuedPromoEmail(email: string, code: string, discount: string, description?: string) {
  await smtpTransporter.sendMail({
    from: `"10coffee" <${process.env.SMTP_EMAIL}>`,
    to: email,
    subject: `Промокод от 10coffee — скидка ${discount}`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px">
        <h2 style="margin:0 0 16px">У вас промокод!</h2>
        <p style="color:#666;margin:0 0 24px">${description || "Используйте промокод при оформлении заказа в личном кабинете."}</p>
        <div style="background:#f5f5f5;border-radius:12px;padding:20px;text-align:center;margin:0 0 24px">
          <p style="margin:0 0 8px;color:#999;font-size:13px">Ваш промокод</p>
          <p style="margin:0;font-weight:bold;font-size:28px;letter-spacing:3px;color:#5b328a">${code}</p>
          <p style="margin:8px 0 0;font-size:14px;font-weight:bold">Скидка ${discount}</p>
        </div>
        <p style="color:#999;font-size:12px;margin:0">Введите промокод при оформлении заказа на сайте.</p>
      </div>
    `,
  })
}

export const PromoCodes: CollectionConfig = {
  slug: "promo-codes",
  admin: {
    useAsTitle: "code",
    group: "Заказы и продажи",
    baseFilter: promoWorkspaceBaseFilter,
    description: "Промокоды и скидки",
    defaultColumns: [
      "code",
      "audience",
      "discountType",
      "discountValue",
      "currentUses",
      "isActive",
    ],
  },
  labels: {
    singular: "Промокод",
    plural: "Промокоды",
  },
  endpoints: [
    {
      path: "/issue-preset",
      method: "post",
      handler: async (req) => {
        const body = await req.json?.()
        const { presetId, clientEmail, clientId } = body || {}

        if (!req.user) {
          return Response.json({ error: "Unauthorized" }, { status: 401 })
        }

        const preset = PROMO_PRESETS.find((p) => p.id === presetId)
        if (!preset) {
          return Response.json({ error: "Preset not found" }, { status: 400 })
        }

        let targetEmail = typeof clientEmail === "string" ? clientEmail.trim() : ""
        let audience: "individual" | "business" = "business"
        if (!targetEmail && clientId) {
          const client = await req.payload.findByID({
            collection: "clients",
            id: clientId,
            depth: 0,
          }) as { email?: string | null; customerType?: "individual" | "business" | null }
          targetEmail = client.email || ""
          audience = client.customerType === "individual" ? "individual" : "business"
        } else if (clientId) {
          const client = await req.payload.findByID({
            collection: "clients",
            id: clientId,
            depth: 0,
          }) as { customerType?: "individual" | "business" | null }
          audience = client.customerType === "individual" ? "individual" : "business"
        }

        const code = `10C-${preset.id.replace("_", "").toUpperCase().slice(0, 6)}-${createPromoSuffix()}`

        const startsAt = new Date().toISOString()
        const expiresAt = new Date(
          Date.now() + preset.daysValid * 24 * 60 * 60 * 1000
        ).toISOString()

        const promoCode = await req.payload.create({
          collection: "promo-codes",
          data: {
            code,
            discountType: preset.discountType,
            discountValue: preset.discountValue,
            isSingleUse: preset.isSingleUse,
            maxUses: preset.maxUses,
            minOrderAmount: preset.minOrderAmount || 0,
            restrictedToEmail: targetEmail || undefined,
            audience,
            startsAt,
            expiresAt,
            isActive: true,
          },
        })

        if (clientId) {
          const client = await req.payload.findByID({
            collection: "clients",
            id: clientId,
            depth: 0,
          }) as { promoCodes?: Array<string | number | { id?: string | number }> | null }
          const existingPromoIds = (client.promoCodes || []).map((promo) =>
            Number(typeof promo === "object" && promo !== null ? promo.id : promo)
          ).filter((id) => Number.isInteger(id) && id > 0)
          await req.payload.update({
            collection: "clients",
            id: clientId,
            data: {
              promoCodes: Array.from(new Set([...existingPromoIds, Number(promoCode.id)])),
            },
          })
        }

        let emailSent = false
        let emailError: string | undefined
        if (targetEmail) {
          try {
            await sendIssuedPromoEmail(
              targetEmail,
              code,
              formatDiscount(preset.discountType, preset.discountValue),
              preset.description
            )
            emailSent = true
          } catch (error) {
            emailError = error instanceof Error ? error.message : "Не удалось отправить письмо"
          }
        }

        return Response.json({ success: true, promoCode, emailSent, emailError })
      },
    },
  ],
  hooks: {
    afterRead: [
      ({ doc }) => {
        doc.audience = doc.audience || "business"
        return doc
      },
    ],
    beforeValidate: [
      ({ data }) => {
        if (data?.code && typeof data.code === "string") {
          data.code = data.code.trim().toUpperCase()
          // Приветственный промокод всегда ограничен первым заказом. Это не
          // позволяет случайно снять ограничение в админке.
          if (data.code === "10COFFEE") {
            data.firstOrderOnly = true
          }
        }
        return data
      },
    ],
  },
  fields: [
    // === Sidebar ===
    {
      name: "isActive",
      type: "checkbox",
      label: "Активен",
      defaultValue: true,
      admin: { position: "sidebar" },
    },
    {
      name: "currentUses",
      type: "number",
      label: "Использований",
      defaultValue: 0,
      admin: { readOnly: true, position: "sidebar" },
    },

    // === Main fields ===
    {
      name: "code",
      type: "text",
      label: "Код промокода",
      required: true,
      unique: true,
      admin: {
        description: "Заглавные буквы, без пробелов",
      },
    },
    {
      name: "description",
      type: "textarea",
      label: "Описание (для менеджера)",
    },
    {
      name: "audience",
      type: "select",
      label: "Для кого действует",
      required: true,
      defaultValue: "business",
      options: [
        { label: "Для всех покупателей", value: "all" },
        { label: "Только для физических лиц", value: "individual" },
        { label: "Только для юридических лиц", value: "business" },
      ],
      admin: {
        description: "Существующие промокоды по умолчанию относятся к оптовому магазину.",
      },
    },
    {
      name: "applicableProducts",
      type: "relationship",
      label: "Товары, участвующие в акции",
      relationTo: "products",
      hasMany: true,
      admin: {
        description: "Оставьте пустым, чтобы промокод действовал на все товары выбранной аудитории.",
      },
    },
    {
      type: "row",
      fields: [
        {
          name: "discountType",
          type: "select",
          label: "Тип скидки",
          required: true,
          options: [
            { label: "Процент (%)", value: "percentage" },
            { label: "Фиксированная сумма (руб)", value: "fixed_amount" },
          ],
          admin: { width: "50%" },
        },
        {
          name: "discountValue",
          type: "number",
          label: "Значение скидки",
          required: true,
          min: 0,
          admin: {
            width: "50%",
            description: "Процент или сумма в рублях",
          },
        },
      ],
    },
    {
      type: "row",
      fields: [
        {
          name: "isSingleUse",
          type: "checkbox",
          label: "Одноразовый",
          defaultValue: false,
          admin: { width: "33%" },
        },
        {
          name: "firstOrderOnly",
          type: "checkbox",
          label: "Только на первый заказ",
          defaultValue: false,
          admin: {
            width: "33%",
            description: "10COFFEE всегда имеет это ограничение.",
          },
        },
        {
          name: "maxUses",
          type: "number",
          label: "Макс. использований",
          admin: {
            width: "17%",
            description: "Пусто = без лимита",
          },
        },
        {
          name: "minOrderAmount",
          type: "number",
          label: "Мин. сумма заказа",
          min: 0,
          admin: { width: "17%" },
        },
      ],
    },
    {
      type: "row",
      fields: [
        {
          name: "startsAt",
          type: "date",
          label: "Действует с",
          admin: {
            width: "50%",
            date: { pickerAppearance: "dayAndTime" },
          },
        },
        {
          name: "expiresAt",
          type: "date",
          label: "Действует до",
          admin: {
            width: "50%",
            date: { pickerAppearance: "dayAndTime" },
            description: "Пусто = бессрочно",
          },
        },
      ],
    },
    {
      name: "restrictedToEmail",
      type: "email",
      label: "Привязка к email клиента",
      admin: {
        description: "Только этот клиент сможет использовать",
      },
    },
  ],
  access: {
    read: ({ req }) => canReadOperations(req.user),
    create: ({ req }) => canManageOperations(req.user),
    update: ({ req }) => canManageOperations(req.user),
    delete: operationsDeleteAccess,
  },
}
