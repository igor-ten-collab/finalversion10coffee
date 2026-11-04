-- Run as the PostgreSQL administrator on the NEW server before restoring.
-- The verified local backup has RLS policies referencing this role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END $$;
