"use server";

import { z } from "zod";
import { createSmtpTransport } from "@/lib/email/smtp";

const smtpTransporter = createSmtpTransport();

const serviceSchema = z.object({
  name: z.string().min(2, "Введите имя"),
  phone: z.string().min(5, "Введите номер телефона"),
  email: z.string().email("Введите корректный email").optional().or(z.literal("")),
  address: z.string().optional(),
  consent: z.literal("on", { error: "Подтвердите согласие на обработку персональных данных" }),
});

const trainingSchema = z.object({
  name: z.string().min(2, "Введите имя"),
  phone: z.string().min(5, "Введите номер телефона"),
  email: z.string().email("Введите корректный email").optional().or(z.literal("")),
  consent: z.literal("on", { error: "Подтвердите согласие на обработку персональных данных" }),
});

export type ContactFormState = {
  success: boolean;
  error?: string;
};

async function sendAcknowledgementEmail(email: string, name: string, subject: string) {
  await smtpTransporter.sendMail({
    from: `"10кофе" <${process.env.SMTP_EMAIL}>`,
    to: email,
    subject,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#1d1d1b">
        <h2 style="margin:0 0 16px">Здравствуйте${name ? `, ${name}` : ""}!</h2>
        <p style="line-height:1.7;margin:0 0 12px">
          Мы получили вашу заявку, наш менеджер свяжется с вами в ближайшее время.
        </p>
        <p style="line-height:1.7;margin:0 0 20px">
          Если у вас есть срочный вопрос, вы можете ответить на это письмо.
        </p>
        <hr style="border:none;border-top:1px solid #eee;margin:0 0 16px" />
        <p style="color:#999;font-size:12px;margin:0">Команда 10coffee</p>
      </div>
    `,
  });
}

export async function submitServiceRequest(
  _prev: ContactFormState,
  formData: FormData,
): Promise<ContactFormState> {
  const parsed = serviceSchema.safeParse({
    name: formData.get("name"),
    phone: formData.get("phone"),
    email: formData.get("email"),
    address: formData.get("address"),
    consent: formData.get("consent"),
  });

  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Ошибка валидации" };
  }

  const { name, phone, email, address } = parsed.data;

  try {
    await smtpTransporter.sendMail({
      from: `"10кофе" <${process.env.SMTP_EMAIL}>`,
      to: "10coffeeroasters@gmail.com",
      subject: "Заявка на сервисное обслуживание",
      html: `
        <div style="font-family:sans-serif;max-width:500px;padding:24px">
          <h2 style="margin-bottom:16px">Новая заявка на сервис</h2>
          <p><strong>Имя:</strong> ${name}</p>
          <p><strong>Телефон:</strong> ${phone}</p>
          ${email ? `<p><strong>Email:</strong> ${email}</p>` : ""}
          ${address ? `<p><strong>Адрес:</strong> ${address}</p>` : ""}
          <hr style="margin-top:24px;border:none;border-top:1px solid #eee"/>
          <p style="color:#999;font-size:12px">Отправлено с сайта 10coffee.ru</p>
        </div>
      `,
    });

    if (email) {
      try {
        await sendAcknowledgementEmail(
          email,
          name,
          "Мы получили вашу заявку | 10кофе",
        );
      } catch {
        // Auto-reply is non-critical
      }
    }

    return { success: true };
  } catch {
    return { success: false, error: "Произошла ошибка. Попробуйте позже." };
  }
}

export async function submitTrainingRequest(
  _prev: ContactFormState,
  formData: FormData,
): Promise<ContactFormState> {
  const parsed = trainingSchema.safeParse({
    name: formData.get("name"),
    phone: formData.get("phone"),
    email: formData.get("email"),
    consent: formData.get("consent"),
  });

  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? "Ошибка валидации" };
  }

  const { name, phone, email } = parsed.data;

  try {
    await smtpTransporter.sendMail({
      from: `"10кофе" <${process.env.SMTP_EMAIL}>`,
      to: "10coffeeroasters@gmail.com",
      subject: "Запись на обучение",
      html: `
        <div style="font-family:sans-serif;max-width:500px;padding:24px">
          <h2 style="margin-bottom:16px">Запись на обучение</h2>
          <p><strong>Имя:</strong> ${name}</p>
          <p><strong>Телефон:</strong> ${phone}</p>
          ${email ? `<p><strong>Email:</strong> ${email}</p>` : ""}
          <hr style="margin-top:24px;border:none;border-top:1px solid #eee"/>
          <p style="color:#999;font-size:12px">Отправлено с сайта 10coffee.ru</p>
        </div>
      `,
    });

    if (email) {
      try {
        await sendAcknowledgementEmail(
          email,
          name,
          "Мы получили вашу заявку на обучение | 10кофе",
        );
      } catch {
        // Auto-reply is non-critical
      }
    }

    return { success: true };
  } catch {
    return { success: false, error: "Произошла ошибка. Попробуйте позже." };
  }
}
