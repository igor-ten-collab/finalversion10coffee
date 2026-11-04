#!/usr/bin/env bash
# Restore the verified local snapshot into an EMPTY application database only.
# No --clean, DROP or TRUNCATE; preserve the uploaded and local backups.
set -Eeuo pipefail
umask 077

readonly expected_sha='5ea56c76a301ddd34d247f281aaa9ed29c1bf9162d03b51aadc8ccd094377ac9'
readonly folder="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly archive="$folder/site.dump"
container="${1:-}"

[[ $(id -u) == 0 ]] || { echo 'Run as root on the new Selectel server.' >&2; exit 1; }
[[ -s "$archive" ]] || { echo 'Backup file is missing or empty.' >&2; exit 1; }
actual_sha="$(sha256sum -- "$archive")"
[[ ${actual_sha%% *} == "$expected_sha" ]] || { echo 'Backup checksum mismatch.' >&2; exit 1; }

if [[ -z "$container" ]]; then
  mapfile -t matches < <(docker ps --filter ancestor=postgres:18-alpine --format '{{.Names}}' | sed '/^coolify-db$/d')
  if [[ ${#matches[@]} != 1 ]]; then
    echo 'Expected one application postgres:18-alpine container. Specify its exact name when there are several.' >&2
    exit 1
  fi
  container="${matches[0]}"
fi
[[ "$container" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ && "$container" != coolify-db ]] || { echo 'Invalid application container.' >&2; exit 1; }
[[ $(docker inspect --format '{{.Config.Image}}' "$container") == postgres:18-alpine ]] || { echo 'Expected postgres:18-alpine.' >&2; exit 1; }
[[ $(docker inspect --format '{{.State.Running}}' "$container") == true ]] || { echo 'Database container is not running.' >&2; exit 1; }

# Commands run inside the verified DB container. Credentials stay there.
psql_in_container() {
  docker exec -i "$container" sh -ceu '
    export PGPASSWORD="${POSTGRES_PASSWORD:-}"
    exec psql --no-psqlrc --username="${POSTGRES_USER:-postgres}" --dbname="${POSTGRES_DB:-postgres}" --set=ON_ERROR_STOP=1 "$@"
  ' sh "$@"
}

table_count="$(psql_in_container --tuples-only --no-align <<'SQL'
SELECT count(*)
FROM information_schema.tables
WHERE table_schema NOT IN ('pg_catalog', 'information_schema');
SQL
)"
[[ "$table_count" == 0 ]] || { echo 'Refusing restore: target database is not empty. No existing tables were changed.' >&2; exit 1; }

echo "Verified empty application database in container: $container"
psql_in_container <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;
END $$;
SQL

readonly container_archive="/tmp/10coffee-recovery-${expected_sha:0:12}.dump"
docker cp "$archive" "$container:$container_archive"
docker exec "$container" pg_restore --list "$container_archive" > "$folder/server-archive-list.txt"
docker exec "$container" sh -ceu '
  export PGPASSWORD="${POSTGRES_PASSWORD:-}"
  exec pg_restore --no-owner --no-acl --exit-on-error --single-transaction \
    --username="${POSTGRES_USER:-postgres}" --dbname="${POSTGRES_DB:-postgres}" "$1"
' sh "$container_archive"

psql_in_container <<'SQL'
BEGIN;
UPDATE public.payment_settings SET enabled = false;
DO $$
BEGIN
  IF (SELECT count(*) FROM public.orders) <> 191
    OR (SELECT count(*) FROM public.clients) <> 54
    OR (SELECT count(*) FROM public.products) <> 30
    OR (SELECT count(*) FROM auth.users) <> 58 THEN
    RAISE EXCEPTION 'Restored counts differ from the verified snapshot';
  END IF;
END $$;
COMMIT;
SELECT 'orders' AS entity, count(*) AS rows FROM public.orders
UNION ALL SELECT 'clients', count(*) FROM public.clients
UNION ALL SELECT 'products', count(*) FROM public.products
UNION ALL SELECT 'auth_users', count(*) FROM auth.users;
SQL

docker exec "$container" rm -- "$container_archive"
printf 'RESTORE VERIFIED: orders=191 clients=54 products=30 auth_users=58; payment_settings.enabled=false\n' | tee "$folder/restore-result.txt"
echo 'The server backup remains in the private recovery folder. Application deployment is a separate step.'
