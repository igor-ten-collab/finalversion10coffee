"use server";

import { getPayload } from "payload";
import configPromise from "@payload-config";
import { parseContactRequest } from "./contact-validation";

export type ContactFormState = {
  success: boolean;
  error?: string;
  name?: string;
};

export async function submitContactRequest(
  _previous: ContactFormState,
  formData: FormData,
): Promise<ContactFormState> {
  const parsed = parseContactRequest({
    name: String(formData.get("name") ?? ""),
    email: String(formData.get("email") ?? ""),
    phone: String(formData.get("phone") ?? ""),
    message: String(formData.get("message") ?? ""),
    consent: formData.get("consent") === "on",
  });

  if (!parsed.success) return parsed;

  try {
    const payload = await getPayload({ config: configPromise });
    await payload.create({
      collection: "contact-requests",
      data: {
        ...parsed.data,
        source: "landing-contact",
      },
      overrideAccess: true,
    });
    return { success: true, name: parsed.data.name };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[contact-request]", message);
    return {
      success: false,
      error: "Не удалось отправить сообщение. Попробуйте позже.",
    };
  }
}
