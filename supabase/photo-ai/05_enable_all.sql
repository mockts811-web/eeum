-- 고현 수정 시작: 파일럿과 백필 결과 검토 후 별도 승인된 범위에서 전체 실행.
-- 일일 상한은 작업 시작 횟수입니다. 기존 ai-parse의 내부 400 대체 호출은 별도로 존재합니다.
-- 기본 예산은 20건/일입니다. 비용을 확인한 후 승인된 예산으로 숫자를 바꾸세요.
BEGIN;
SELECT public.eeum_photo_ai_configure('all',NULL,20);
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
-- 고현 수정 끝: 승인된 범위에서 전체 실행
