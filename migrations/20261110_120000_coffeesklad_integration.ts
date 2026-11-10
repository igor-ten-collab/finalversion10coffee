import { sql } from "@payloadcms/db-postgres"
import type { MigrateDownArgs, MigrateUpArgs } from "@payloadcms/db-postgres"

// Интеграция с КофеСклад: поля синхронизации в заказах и артикул молотого
// варианта в товарах.
export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "coffeesklad_sync_status" varchar DEFAULT 'disabled';
    ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "coffeesklad_order_number" varchar;
    ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "coffeesklad_synced_at" timestamp(3) with time zone;
    ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "coffeesklad_sync_error" varchar;
    ALTER TABLE "products_variants" ADD COLUMN IF NOT EXISTS "sku_ground" varchar;
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "orders" DROP COLUMN IF EXISTS "coffeesklad_sync_status";
    ALTER TABLE "orders" DROP COLUMN IF EXISTS "coffeesklad_order_number";
    ALTER TABLE "orders" DROP COLUMN IF EXISTS "coffeesklad_synced_at";
    ALTER TABLE "orders" DROP COLUMN IF EXISTS "coffeesklad_sync_error";
    ALTER TABLE "products_variants" DROP COLUMN IF EXISTS "sku_ground";
  `)
}
