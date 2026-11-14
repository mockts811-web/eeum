-- 고현 수정 시작: 사용자 요청에 따라 기존·신규 외부 사진을 자동 분석하고 공개 특징에 저장
-- 08_public_features.sql 적용과 1건 파일럿 확인 후 실행합니다. 기존 완료 결과는 재분석하지 않습니다.
-- 기존 사진 278건을 순차 처리하기 위한 일일 상한 300작업. 전역 분당 1건과 최대 3회 재시도는 유지합니다.
BEGIN;
SELECT public.eeum_photo_ai_configure('all',NULL,300);
UPDATE eeum_photo_ai.control SET publish_public=true WHERE singleton;
SELECT public.eeum_photo_ai_backfill(NULL,1000);
DO $$ DECLARE v_job bigint; BEGIN
  IF (SELECT count(*) FROM cron.job WHERE jobname='eeum-photo-ai-v1'
    AND command LIKE '%/functions/v1/auto-analyze-items%' AND command LIKE '%x-photo-ai-secret%')<>1 THEN
    RAISE EXCEPTION 'owned_cron_not_found';
  END IF;
  FOR v_job IN SELECT jobid FROM cron.job WHERE jobname='eeum-photo-ai-v1'
    AND command LIKE '%/functions/v1/auto-analyze-items%' AND command LIKE '%x-photo-ai-secret%'
  LOOP PERFORM cron.alter_job(v_job,active:=true); END LOOP;
END $$;
COMMIT;
-- 고현 수정 끝: 기존·신규 외부 사진의 공개 특징 자동 저장
