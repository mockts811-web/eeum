-- 고현 수정 시작: 새 자동화만 중지. 원본·큐·결과·기존 예약을 보존합니다.
BEGIN;
SELECT public.eeum_photo_ai_configure('off');
DO $$ DECLARE v_job bigint; BEGIN
  IF to_regclass('cron.job') IS NOT NULL THEN
    FOR v_job IN SELECT jobid FROM cron.job WHERE jobname='eeum-photo-ai-v1'
      AND command LIKE '%/functions/v1/auto-analyze-items%' AND command LIKE '%x-photo-ai-secret%'
    LOOP PERFORM cron.alter_job(v_job,active:=false); END LOOP;
  END IF;
END $$;
COMMIT;
-- 고현 수정 끝: 새 자동화만 중지
