-- 고현 수정 시작: 운영 구조 확인 전용. 데이터/스키마/권한/예약을 변경하지 않습니다.
-- 운영 SQL Editor에서 이 파일을 먼저 조회합니다. 결과에는 키/메모/개별 물품을 포함하지 않습니다.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';

SELECT clock_timestamp() AS observed_at,
       current_database() AS database_name,
       current_user AS inspection_role,
       current_setting('server_version') AS server_version;

SELECT n.nspname AS schema_name, c.relname AS relation_name,
       c.relkind, c.relrowsecurity, c.relforcerowsecurity,
       pg_get_userbyid(c.relowner) AS owner
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE (n.nspname = 'public' AND c.relname IN
       ('items','item_private','staff_members','orgs','item_photo_ai_jobs','item_photo_ai_results'))
   OR (n.nspname = 'storage' AND c.relname IN ('objects','buckets'))
ORDER BY n.nspname, c.relname;

SELECT n.nspname AS schema_name, c.relname AS table_name, a.attname AS column_name,
       format_type(a.atttypid, a.atttypmod) AS column_type,
       a.attnotnull, a.attidentity, a.attgenerated,
       pg_get_expr(d.adbin, d.adrelid) AS default_expression
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
WHERE a.attnum > 0 AND NOT a.attisdropped
  AND ((n.nspname = 'public' AND c.relname IN ('items','item_private','staff_members','orgs'))
    OR (n.nspname = 'storage' AND c.relname IN ('objects','buckets')))
ORDER BY n.nspname, c.relname, a.attnum;

SELECT n.nspname AS schema_name, c.relname AS table_name,
       con.conname, con.contype, con.convalidated,
       pg_get_constraintdef(con.oid, true) AS constraint_definition
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname IN ('items','item_private','staff_members','orgs')
ORDER BY c.relname, con.conname;

-- pg_index에는 relname이 없습니다. 인덱스의 pg_class를 별도로 조인합니다.
SELECT tab.relname AS table_name, idx.relname AS index_name,
       i.indisprimary, i.indisunique, i.indisvalid, i.indisready,
       i.indnkeyatts, i.indnatts,
       pg_get_expr(i.indpred, i.indrelid) AS partial_predicate,
       pg_get_indexdef(i.indexrelid) AS index_definition
FROM pg_index i
JOIN pg_class tab ON tab.oid = i.indrelid
JOIN pg_class idx ON idx.oid = i.indexrelid
JOIN pg_namespace n ON n.oid = tab.relnamespace
WHERE n.nspname = 'public' AND tab.relname IN ('items','item_private')
ORDER BY tab.relname, idx.relname;

SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename IN ('items','item_private','staff_members','orgs')
ORDER BY tablename, policyname;

SELECT n.nspname AS schema_name, c.relname AS table_name,
       CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(acl.grantee) END AS grantee,
       acl.privilege_type, acl.is_grantable
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl
WHERE n.nspname = 'public' AND c.relname IN ('items','item_private','staff_members','orgs')
ORDER BY c.relname, grantee, acl.privilege_type;

SELECT table_schema, table_name, column_name, grantee, privilege_type
FROM information_schema.column_privileges
WHERE table_schema = 'public' AND table_name IN ('items','item_private')
  AND grantee IN ('anon','authenticated','service_role','PUBLIC')
ORDER BY table_name, column_name, grantee, privilege_type;

SELECT c.relname AS table_name, t.tgname, t.tgenabled,
       p.oid::regprocedure::text AS trigger_function,
       md5(pg_get_triggerdef(t.oid, true)) AS definition_md5
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_proc p ON p.oid = t.tgfoid
WHERE NOT t.tgisinternal AND n.nspname = 'public'
  AND c.relname IN ('items','item_private')
ORDER BY c.relname, t.tgname;

-- 함수 본문에는 기존 하드코딩 비밀값이 있을 수 있어 원문 대신 식별자/해시만 조회합니다.
SELECT n.nspname AS schema_name, p.oid::regprocedure::text AS function_identity,
       pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS security_definer,
       p.proacl,
       ARRAY(SELECT setting FROM unnest(p.proconfig) AS setting
             WHERE setting LIKE 'search_path=%') AS search_path_settings,
       md5(pg_get_functiondef(p.oid)) AS definition_md5
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.prokind = 'f' AND
  ((n.nspname = 'public' AND
    (p.proname LIKE 'eeum\_%' ESCAPE '\' OR p.proname = 'touch_updated_at'))
   OR (n.nspname = 'net' AND p.proname = 'http_post'))
ORDER BY n.nspname, function_identity;

SELECT rolname, rolcanlogin, rolinherit, rolbypassrls
FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role','postgres');

SELECT extname, extversion FROM pg_extension
WHERE extname IN ('pg_cron','pg_net','supabase_vault','pgcrypto');
SELECT to_regclass('cron.job') IS NOT NULL AS cron_job_exists,
       to_regclass('vault.decrypted_secrets') IS NOT NULL AS vault_view_exists;

COMMIT;
-- 고현 수정 끝: 운영 구조 확인 전용
