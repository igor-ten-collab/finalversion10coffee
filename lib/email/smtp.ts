import nodemailer, { type SendMailOptions } from "nodemailer"

export function getSmtpOptions(env: Record<string, string | undefined> = process.env) {
  const host = env.SMTP_HOST?.trim()
  const common = {
    auth: {
      user: env.SMTP_USER?.trim() || env.SMTP_EMAIL?.trim(),
      pass: env.SMTP_PASSWORD,
    },
    dnsTimeout: 5000,
    connectionTimeout: 5000,
    greetingTimeout: 5000,
    socketTimeout: 10000,
  }

  // Existing Gmail installations work without any additional variables.
  // Do not pass service=gmail with a custom host: it overrides host/port/TLS.
  if (!host) return { ...common, service: "gmail" }

  const port = Number(env.SMTP_PORT?.trim() || "465")
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SMTP_PORT must be a port number from 1 to 65535")
  }
  const secureValue = env.SMTP_SECURE?.trim().toLowerCase()
  if (secureValue && secureValue !== "true" && secureValue !== "false") {
    throw new Error("SMTP_SECURE must be true or false")
  }
  const secure = secureValue ? secureValue === "true" : port === 465
  return {
    ...common,
    host,
    port,
    secure,
    // Custom submission endpoints must use TLS or negotiate STARTTLS.
    requireTLS: !secure,
  }
}

export function createSmtpTransport() {
  return nodemailer.createTransport(getSmtpOptions())
}

// Record relay acceptance separately from delivery. Never log credentials,
// recipients or message bodies (password emails contain a generated password).
export async function sendSmtpMail(
  transporter: ReturnType<typeof createSmtpTransport>,
  operation: "registration" | "password-reset" | "price-list",
  message: SendMailOptions,
) {
  try {
    const info = await transporter.sendMail(message)
    console.info("[SMTP]", JSON.stringify({
      operation,
      status: "accepted",
      messageId: info.messageId || null,
      acceptedCount: info.accepted?.length || 0,
      rejectedCount: info.rejected?.length || 0,
    }))
    return info
  } catch (error) {
    const failure = error as { code?: string; responseCode?: number; command?: string }
    console.error("[SMTP]", JSON.stringify({
      operation,
      status: "failed",
      code: failure?.code || "SMTP_SEND_FAILED",
      responseCode: failure?.responseCode,
      command: failure?.command,
    }))
    throw error
  }
}
