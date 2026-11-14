-- 고현 수정 시작: 한 결과표로 공유하는 첫 운영 스키마 조회. SELECT만 사용합니다.
WITH target AS (
  SELECT c.* FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relname IN ('items','item_private','staff_members','orgs')
)
SELECT 'table' AS section, t.relname::text AS table_name,
  jsonb_build_object('rls', t.relrowsecurity, 'force_rls', t.relforcerowsecurity) AS detail
FROM target t
UNION ALL
SELECT 'column', t.relname::text,
  jsonb_build_object('name', a.attname, 'type', format_type(a.atttypid,a.atttypmod),
    'not_null', a.attnotnull, 'has_default', a.atthasdef)
FROM target t JOIN pg_attribute a ON a.attrelid = t.oid
WHERE a.attnum > 0 AND NOT a.attisdropped
UNION ALL
SELECT 'index', t.relname::text,
  jsonb_build_object('definition', pg_get_indexdef(i.indexrelid), 'valid', i.indisvalid)
FROM target t JOIN pg_index i ON i.indrelid = t.oid
UNION ALL
SELECT 'policy', p.tablename::text,
  jsonb_build_object('name', p.policyname, 'roles', p.roles, 'command', p.cmd,
    'using', p.qual, 'check', p.with_check, 'permissive', p.permissive)
FROM pg_policies p
WHERE p.schemaname = 'public' AND p.tablename IN (SELECT relname FROM target)
UNION ALL
SELECT 'grant', t.relname::text,
  jsonb_build_object('role', CASE WHEN acl.grantee = 0 THEN 'PUBLIC'
    ELSE pg_get_userbyid(acl.grantee) END, 'privilege', acl.privilege_type)
FROM target t
CROSS JOIN LATERAL aclexplode(coalesce(t.relacl, acldefault('r',t.relowner))) acl
UNION ALL
SELECT 'trigger', t.relname::text,
  jsonb_build_object('name', tr.tgname, 'enabled', tr.tgenabled,
    'function', tr.tgfoid::regprocedure::text)
FROM target t JOIN pg_trigger tr ON tr.tgrelid = t.oid
WHERE NOT tr.tgisinternal
ORDER BY 1, 2, 3;
-- 고현 수정 끝: 한 결과표로 공유하는 첫 운영 스키마 조회
