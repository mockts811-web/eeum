-- 고현 수정 시작: 승인 전 읽기 전용 운영 전제 확인. 비밀값/개별 사진/메모는 출력하지 않습니다.
BEGIN READ ONLY;
SET LOCAL statement_timeout='15s';
SELECT current_setting('server_version') AS postgres_version,
  to_regnamespace('eeum_photo_ai') IS NOT NULL AS new_schema_exists,
  to_regclass('public.item_photo_ai_jobs') IS NOT NULL AS old_B_queue_exists,
  to_regclass('cron.job') IS NOT NULL AS cron_exists,
  to_regclass('vault.decrypted_secrets') IS NOT NULL AS vault_exists,
  to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') IS NOT NULL AS net_http_signature_supported;
SELECT a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull
FROM pg_attribute a WHERE a.attrelid=to_regclass('storage.objects') AND a.attnum>0 AND NOT a.attisdropped
  AND a.attname IN ('id','bucket_id','name','metadata','version','updated_at') ORDER BY a.attnum;
SELECT id,public,file_size_limit,allowed_mime_types FROM storage.buckets WHERE id='item-photos';
SELECT p.proname,p.oid::regprocedure::text AS identity,md5(pg_get_functiondef(p.oid)) AS definition_md5
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname='public' AND p.prokind='f' AND p.proname LIKE 'eeum%';
SELECT count(*) FILTER(WHERE created_by IS NULL) AS server_created_items,
  count(*) FILTER(WHERE created_by IS NULL AND status<>'수령완료'
    AND (id ~ '^(POL|POR)-[A-Za-z0-9]+-[0-9]+$' OR id ~ '^[PFB][0-9]{13,}$')
    AND photo_path LIKE 'api/%'
    AND photo_path !~* '(^|/)(no_image|no_img)\.(jpeg|jpg|png|gif)([?#].*)?$') AS storage_path_candidates
FROM public.items;
COMMIT;
-- 고현 수정 끝: 읽기 전용 운영 전제 확인
