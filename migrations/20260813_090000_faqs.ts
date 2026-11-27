import { sql } from "@payloadcms/db-postgres"
import type { MigrateDownArgs, MigrateUpArgs } from "@payloadcms/db-postgres"

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    CREATE SEQUENCE IF NOT EXISTS "faqs_id_seq";

    CREATE TABLE IF NOT EXISTS "faqs" (
      "id" integer NOT NULL DEFAULT nextval('faqs_id_seq'::regclass),
      "question" text NOT NULL,
      "answer" text,
      "status" varchar NOT NULL DEFAULT 'pending',
      "source" varchar NOT NULL DEFAULT 'manual',
      "name" varchar,
      "email" varchar,
      "created_at" timestamptz NOT NULL DEFAULT now(),
      "updated_at" timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY ("id")
    );

    CREATE INDEX IF NOT EXISTS "faqs_status_idx" ON "faqs" USING btree ("status");
    CREATE INDEX IF NOT EXISTS "faqs_updated_at_idx" ON "faqs" USING btree ("updated_at" DESC);

    -- Payload stores document locks for every collection in this technical table.
    -- Keep the initial migration complete for newly created databases.
    ALTER TABLE "payload_locked_documents_rels" ADD COLUMN IF NOT EXISTS "faqs_id" integer;

    INSERT INTO "faqs" ("question", "answer", "status", "source")
    SELECT seed.question, seed.answer, 'published', 'manual'
      FROM (VALUES
        ('Когда обжаривается кофе?', 'Мы обжариваем кофе небольшими партиями и отправляем максимально свежим. Дата обжарки указывается на упаковке.'),
        ('Можно заказать кофе уже молотым?', 'Да. Если у товара доступен помол, выберите подходящий вариант прямо в карточке перед добавлением в корзину.'),
        ('Как доставляются заказы?', 'По России отправляем СДЭК, по Сочи доступна городская доставка, также заказ можно бесплатно забрать самостоятельно.'),
        ('Можно оформить заказ без регистрации?', 'Да, регистрация необязательна. Она нужна только для истории заказов, избранного и более быстрого оформления следующих покупок.'),
        ('Что делать, если товар не подошёл?', 'Напишите нам на 10coffee@mail.ru или в мессенджер MAX +7 (938) 453-70-60 и укажите номер заказа. Мы разберём обращение и подскажем порядок возврата.')
      ) AS seed(question, answer)
     WHERE NOT EXISTS (SELECT 1 FROM "faqs" WHERE "faqs"."question" = seed.question);
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    DROP TABLE IF EXISTS "faqs" CASCADE;
    DROP SEQUENCE IF EXISTS "faqs_id_seq";
    ALTER TABLE "payload_locked_documents_rels" DROP COLUMN IF EXISTS "faqs_id";
  `)
}
