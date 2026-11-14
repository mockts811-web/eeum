-- 고현 수정 시작: 신규 유입 사진만 자동 실행. 기존 사진의 일괄 백필은 하지 않습니다.
BEGIN;
SELECT public.eeum_photo_ai_configure('new',NULL,20);
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
-- 고현 수정 끝: 신규 유입 사진만 자동 실행
