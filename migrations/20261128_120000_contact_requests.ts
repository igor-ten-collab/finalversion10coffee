import { sql } from "@payloadcms/db-postgres";
import type { MigrateDownArgs, MigrateUpArgs } from "@payloadcms/db-postgres";

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "contact_requests" (
      "id" serial PRIMARY KEY NOT NULL,
      "name" varchar NOT NULL,
      "email" varchar,
      "phone" varchar,
      "message" varchar NOT NULL,
      "consent" boolean NOT NULL,
      "source" varchar DEFAULT 'landing-contact',
      "updated_at" timestamptz DEFAULT now() NOT NULL,
      "created_at" timestamptz DEFAULT now() NOT NULL
    );

    CREATE INDEX IF NOT EXISTS "contact_requests_updated_at_idx"
      ON "contact_requests" ("updated_at");
    CREATE INDEX IF NOT EXISTS "contact_requests_created_at_idx"
      ON "contact_requests" ("created_at");

    ALTER TABLE "payload_locked_documents_rels"
      ADD COLUMN IF NOT EXISTS "contact_requests_id" integer;

    DO $$ BEGIN
      ALTER TABLE "payload_locked_documents_rels"
        ADD CONSTRAINT "payload_locked_documents_rels_contact_requests_fk"
        FOREIGN KEY ("contact_requests_id") REFERENCES "public"."contact_requests"("id")
        ON DELETE cascade ON UPDATE no action;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;

    CREATE INDEX IF NOT EXISTS "payload_locked_documents_rels_contact_requests_id_idx"
      ON "payload_locked_documents_rels" ("contact_requests_id");
  `);
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "payload_locked_documents_rels"
      DROP COLUMN IF EXISTS "contact_requests_id";
    DROP TABLE IF EXISTS "contact_requests";
  `);
}
