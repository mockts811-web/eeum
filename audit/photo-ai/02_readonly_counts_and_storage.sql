-- 고현 수정 시작: 외부 물품/Storage 메타데이터 집계 전용
-- 01 파일로 아래 컬럼의 존재/타입을 먼저 확인한 뒤 조회합니다. 사진/개인정보 본문은 조회하지 않습니다.
-- API 공개 범위와 다른 운영 전체 집계입니다. 관측 시각/권한을 함께 기록하세요.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '20s';

SELECT clock_timestamp() AS observed_at, current_user AS inspection_role;
SELECT 'items' AS table_name, count(*) AS row_count FROM public.items
UNION ALL SELECT 'item_private', count(*) FROM public.item_private;

WITH classified AS (
  SELECT *,
    id ~ '^(POL|POR)-[A-Za-z0-9]+-[0-9]+$' OR id ~ '^[PFB][0-9]{13,}$' AS external_id,
    coalesce(btrim(photo_path), '') = '' AS empty_photo,
    coalesce(photo_path, '') ~* '(^|/)(no_image|no_img)\.(jpeg|jpg|png|gif)([?#].*)?$' AS placeholder
  FROM public.items
)
SELECT
  count(*) FILTER (WHERE external_id) AS id_matches_including_staff,
  count(*) FILTER (WHERE external_id AND created_by IS NULL) AS external_created_by_null,
  count(*) FILTER (WHERE external_id AND created_by IS NOT NULL) AS staff_rows_matching_external_id,
  count(*) FILTER (WHERE external_id AND created_by IS NULL AND status = '수령완료') AS external_received,
  count(*) FILTER (WHERE external_id AND created_by IS NULL AND status <> '수령완료') AS external_active,
  count(*) FILTER (WHERE external_id AND created_by IS NULL AND placeholder) AS external_placeholder,
  count(*) FILTER (WHERE external_id AND created_by IS NULL AND empty_photo) AS external_no_photo,
  count(*) FILTER (WHERE external_id AND created_by IS NULL AND status <> '수령완료'
    AND NOT placeholder AND NOT empty_photo
    AND (photo_path LIKE 'api/%' OR photo_path LIKE 'https://%')) AS queue_candidates_before_status_check
FROM classified;

-- 첨부안의 ID 정규식에 맞지 않는 서버 등록 행도 별도로 집계해 누락 가능성을 확인합니다.
-- 아래 집계는 누락 가능성을 보여줄 뿐, 해당 행을 외부 API 자료로 단정하지 않습니다.
SELECT count(*) AS server_rows_outside_draft_id_patterns
FROM public.items
WHERE created_by IS NULL
  AND NOT (id ~ '^(POL|POR)-[A-Za-z0-9]+-[0-9]+$' OR id ~ '^[PFB][0-9]{13,}$');

WITH candidates AS (
  SELECT id, photo_path,
    CASE
      WHEN photo_path LIKE 'api/%' THEN photo_path
      WHEN photo_path LIKE 'https://xhvthvxpwlaecizqlrrv.supabase.co/storage/v1/object/public/item-photos/%'
        THEN substr(photo_path, length('https://xhvthvxpwlaecizqlrrv.supabase.co/storage/v1/object/public/item-photos/') + 1)
      ELSE NULL
    END AS object_name
  FROM public.items
  WHERE created_by IS NULL AND status <> '수령완료'
    AND (id ~ '^(POL|POR)-[A-Za-z0-9]+-[0-9]+$' OR id ~ '^[PFB][0-9]{13,}$')
    AND coalesce(btrim(photo_path), '') <> ''
    AND (photo_path LIKE 'api/%' OR photo_path LIKE 'https://%')
    AND photo_path !~* '(^|/)(no_image|no_img)\.(jpeg|jpg|png|gif)([?#].*)?$'
), metadata AS (
  SELECT c.id, c.object_name, s.id AS storage_id,
    CASE WHEN s.metadata->>'size' ~ '^[0-9]+$'
      THEN (s.metadata->>'size')::numeric ELSE NULL END AS bytes,
    lower(s.metadata->>'mimetype') AS mime
  FROM candidates c LEFT JOIN storage.objects s
    ON s.bucket_id = 'item-photos' AND s.name = c.object_name
)
SELECT count(*) AS candidate_rows,
  count(storage_id) AS matching_storage_objects,
  count(*) FILTER (WHERE object_name IS NULL) AS external_urls_without_local_metadata,
  count(*) FILTER (WHERE object_name IS NOT NULL AND storage_id IS NULL) AS missing_storage_objects,
  count(*) FILTER (WHERE storage_id IS NOT NULL AND bytes IS NULL) AS unknown_size,
  count(*) FILTER (WHERE bytes <= 8000000) AS within_actual_remote_byte_limit,
  count(*) FILTER (WHERE bytes > 8000000 AND bytes <= 8388608) AS between_8000000_and_8MiB,
  count(*) FILTER (WHERE bytes > 8388608) AS above_8MiB,
  count(*) FILTER (WHERE bytes <= 8000000 AND mime IN ('image/jpeg','image/png','image/webp'))
    AS size_and_mime_candidates_only
FROM metadata;

SELECT id, public, file_size_limit, allowed_mime_types
FROM storage.buckets WHERE id = 'item-photos';
-- 크기/MIME 메타데이터만으로 실제 다운로드·magic 검사·Gemini 성공을 보장할 수 없습니다.
COMMIT;
-- 고현 수정 끝: 외부 물품/Storage 메타데이터 집계 전용
