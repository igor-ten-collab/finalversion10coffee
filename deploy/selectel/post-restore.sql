-- Run only against the restored NEW database, keeping the source dump intact.
-- YooKassa's DB flag overrides YOOKASSA_ENABLED from the environment.
BEGIN;
UPDATE public.payment_settings SET enabled = false;
COMMIT;

SELECT 'orders' AS entity, count(*) AS rows FROM public.orders
UNION ALL SELECT 'clients', count(*) FROM public.clients
UNION ALL SELECT 'products', count(*) FROM public.products
UNION ALL SELECT 'auth_users', count(*) FROM auth.users;
