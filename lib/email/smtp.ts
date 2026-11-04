import nodemailer from "nodemailer"

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
