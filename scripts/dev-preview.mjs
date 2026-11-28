// Local visual preview defaults. Existing environment variables always win.
const previewEnv = {
  DATABASE_URL: "postgres://preview:preview@127.0.0.1:55432/preview",
  PAYLOAD_SECRET: "local-preview-only-not-for-production",
  PAYLOAD_DB_PUSH: "false",
  NEXT_PUBLIC_SERVER_URL: "http://localhost:7100",
  NEXT_PUBLIC_SITE_URL: "http://localhost:7100",
  NEXT_TELEMETRY_DISABLED: "1",
  YOOKASSA_ENABLED: "false",
  MOYSKLAD_ENABLED: "false",
  SHOP_RESTRICT_ACCESS: "false",
}

for (const [name, value] of Object.entries(previewEnv)) {
  if (!process.env[name]?.trim()) process.env[name] = value
}

// Kimi Work and other preview runners commonly pass Vite-style --host.
const forwardedArgs = process.argv.slice(2).map((argument) =>
  argument === "--host" || argument === "-H" ? "--hostname" : argument
)

process.argv = [process.argv[0], "next", "dev", "--webpack", ...forwardedArgs]
await import("next/dist/bin/next")
