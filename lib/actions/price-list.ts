"use server";

import { z } from "zod";
import type { SendMailOptions } from "nodemailer";
import { createSmtpTransport, sendSmtpMail } from "@/lib/email/smtp";
import { getPayload } from "payload";
import configPromise from "@payload-config";

const priceListSchema = z.object({
  name: z.string().min(2, "Введите имя"),
  email: z.string().email("Введите корректный email"),
  phone: z.string().min(5, "Введите номер телефона"),
  company: z.string().optional(),
  consent: z.literal("on", { error: "Подтвердите согласие на обработку персональных данных" }),
});

export type PriceListState = {
  success: boolean;
  error?: string;
  name?: string;
  emailSent?: boolean;
};

const smtpTransporter = createSmtpTransport();

export async function submitPriceListRequest(
  _prev: PriceListState,
  formData: FormData,
): Promise<PriceListState> {
  const parsed = priceListSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    phone: formData.get("phone"),
    company: formData.get("company"),
    consent: formData.get("consent"),
  });

  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Ошибка валидации",
    };
  }

  const { name, email, phone, company } = parsed.data;

  try {
    const payload = await getPayload({ config: configPromise });

    // 1. Save to Payload admin
    const record = await payload.create({
      collection: "price-list-requests",
      data: {
        name,
        email,
        phone,
        company: company || undefined,
        emailSent: false,
      },
    });

    // 2. Resolve price list file from SiteSettings
    const { getSiteSettings } = await import("@/lib/actions/site-settings");
    const settings = await getSiteSettings();
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || process.env.NEXT_PUBLIC_SERVER_URL || "https://10coffee.ru";

    const attachments: SendMailOptions["attachments"] = [];

    // The uploaded file is the single source for the public price-list link and email attachment.
    const emailFile = settings?.priceListForm?.emailFile;
    if (!emailFile?.url) {
      console.error("[price-list]", JSON.stringify({ requestId: record.id, code: "PRICE_LIST_NOT_CONFIGURED" }));
      return { success: true, name, emailSent: false };
    }
    try {
      // Download the configured PDF before opening SMTP. Missing files from
      // an incomplete media restore must not produce a false email success.
      const response = await fetch(new URL(emailFile.url, siteUrl), { signal: AbortSignal.timeout(15000) });
      if (!response.ok) {
        console.error("[price-list]", JSON.stringify({ requestId: record.id, code: "PRICE_LIST_HTTP_ERROR", httpStatus: response.status }));
        return { success: true, name, emailSent: false };
      }
      attachments.push({
        filename: emailFile.filename || "Прайс-лист 10кофе.pdf",
        content: Buffer.from(await response.arrayBuffer()),
        contentType: "application/pdf",
      });
    } catch (error) {
      const failure = error as { code?: string; name?: string };
      console.error("[price-list]", JSON.stringify({ requestId: record.id, code: failure?.code || failure?.name || "PRICE_LIST_DOWNLOAD_FAILED" }));
      return { success: true, name, emailSent: false };
    }

    // Sender info from settings
    const senderName = settings?.priceListForm?.senderName || "Команда 10кофе";
    const senderPosition = settings?.priceListForm?.senderPosition || "Руководитель отдела продаж";
    const senderPhone = settings?.priceListForm?.senderPhone || "";
    const senderTelegram = settings?.priceListForm?.senderTelegram || "@Ten120886";
    // 3. Send email to client
    let emailSent = false;
    try {
      await sendSmtpMail(smtpTransporter, "price-list", {
        from: `"10кофе" <${process.env.SMTP_EMAIL}>`,
        to: email,
        subject: "Прайс-лист и условия сотрудничества | 10кофе",
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#1d1d1b">
            <h2 style="margin-bottom:16px">Добрый день, ${name}!</h2>
            <p style="line-height:1.7;margin-bottom:12px">
              Спасибо за интерес к компании 10кофе. Вы оставляли заявку на сайте, чтобы получить прайс-лист — направляю его во вложении к этому письму.
            </p>
            <p style="line-height:1.7;margin-bottom:8px">В файле вы найдете актуальные цены на:</p>
            <ul style="line-height:1.8;margin:0 0 16px;padding-left:20px">
              <li>☕ Кофе собственной обжарки (всегда свежий, жарим под заказ)</li>
              <li>🍵 Чай (премиальные сорта)</li>
              <li>⚙️ Кофейное оборудование и аксессуары</li>
            </ul>
            <p style="line-height:1.7;margin-bottom:16px">
              Прайс достаточно объемный, поэтому если вы ищете что-то конкретное (например, смесь для эспрессо в офис или оборудование для кофейни) — просто ответьте на это письмо или позвоните мне.<br><br>
              Я помогу сориентироваться в сортах, рассчитаю стоимость под ваш бюджет и, при необходимости, организую дегустацию образцов.
            </p>
            <p style="line-height:1.9;margin-bottom:24px">
              Мои контакты для быстрой связи:<br>
              ${senderPhone ? `📞 ${senderPhone}<br>` : ""}
              💬 <a href="https://t.me/${senderTelegram.replace("@", "")}" style="color:#e6610d">${senderTelegram}</a><br>
              🌐 <a href="${siteUrl}" style="color:#e6610d">${siteUrl}</a>
            </p>
            <p style="margin-bottom:4px">Хорошего дня и вкусного кофе!</p>
            <p style="margin-bottom:20px">
              С уважением,<br>
              <strong>${senderName}</strong><br>
              <span style="color:#888;font-size:14px">${senderPosition}, компания 10кофе</span>
            </p>
            <hr style="border:none;border-top:1px solid #eee;margin:0 0 16px"/>
            <p style="color:#999;font-size:12px">10кофе — оптовые поставки кофе для бизнеса</p>
          </div>
        `,
        attachments,
      });
      emailSent = true;
    } catch {
      // The shared SMTP helper records the failure; the request stays saved.
    }

    // 4. Update emailSent status
    if (emailSent) {
      await payload.update({
        collection: "price-list-requests",
        id: record.id,
        data: { emailSent: true },
      });
    }

    return { success: true, name, emailSent };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : err;
    console.error("[price-list] Error:", message);
    return { success: false, error: "Произошла ошибка. Попробуйте позже." };
  }
}
