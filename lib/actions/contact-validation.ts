import { z } from "zod";

export type ContactRequestInput = {
  name: string;
  email: string;
  phone: string;
  message: string;
  consent: boolean;
};

const contactRequestSchema = z.object({
  name: z.string().trim().min(2, "Введите имя"),
  email: z.string().trim().refine(
    (value) => !value || z.email().safeParse(value).success,
    "Введите корректный email",
  ),
  phone: z.string().trim().refine(
    (value) => !value || value.length >= 5,
    "Введите номер телефона",
  ),
  message: z.string().trim().min(10, "Напишите сообщение (минимум 10 символов)"),
  consent: z.literal(true, { error: "Подтвердите согласие на обработку персональных данных" }),
}).superRefine((data, ctx) => {
  if (!data.email && !data.phone) {
    ctx.addIssue({
      code: "custom",
      path: ["email"],
      message: "Укажите email или телефон для связи",
    });
  }
});

export type ContactRequestData = z.infer<typeof contactRequestSchema>;

export type ContactRequestParseResult =
  | { success: true; data: ContactRequestData }
  | { success: false; error: string };

export function parseContactRequest(input: ContactRequestInput): ContactRequestParseResult {
  const parsed = contactRequestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Проверьте заполнение формы",
    };
  }
  return { success: true, data: parsed.data };
}
