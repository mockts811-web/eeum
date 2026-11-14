-- 고현 수정 시작: 새 예약만 생성하며 같은 트랜잭션에서 비활성으로 설정합니다.
-- 별도 승인 후 실행합니다. 기존 예약은 수정하지 않습니다. 확장은 자동 설치하지 않습니다.
-- 전용 Vault 이름이 없으면 기존 project_url / cron_secret을 재사용합니다. 비밀값은 출력하지 않습니다.
BEGIN;
DO $$
DECLARE v_job bigint; v_url_name text; v_secret_name text;
BEGIN
  IF to_regclass('cron.job') IS NULL OR to_regclass('vault.decrypted_secrets') IS NULL OR
    to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') IS NULL THEN
    RAISE EXCEPTION 'cron_net_vault_preflight_required';
  END IF;
  IF EXISTS(SELECT 1 FROM cron.job WHERE jobname='eeum-photo-ai-v1') THEN RAISE EXCEPTION 'cron_name_collision'; END IF;
  v_url_name:=CASE WHEN EXISTS(SELECT 1 FROM vault.decrypted_secrets WHERE name='eeum_photo_ai_project_url')
    THEN 'eeum_photo_ai_project_url' ELSE 'project_url' END;
  v_secret_name:=CASE WHEN EXISTS(SELECT 1 FROM vault.decrypted_secrets WHERE name='eeum_photo_ai_worker_secret')
    THEN 'eeum_photo_ai_worker_secret' ELSE 'cron_secret' END;
  IF (SELECT count(*) FROM vault.decrypted_secrets WHERE name=v_url_name)<>1 OR
     (SELECT count(*) FROM vault.decrypted_secrets WHERE name=v_secret_name)<>1 THEN
    RAISE EXCEPTION 'vault_name_count_mismatch';
  END IF;
  IF (SELECT rtrim(decrypted_secret,'/') FROM vault.decrypted_secrets WHERE name=v_url_name)
      IS DISTINCT FROM (SELECT project_url FROM eeum_photo_ai.control WHERE singleton) OR
     (SELECT length(btrim(decrypted_secret)) FROM vault.decrypted_secrets WHERE name=v_secret_name)<32 THEN
    RAISE EXCEPTION 'vault_config_mismatch';
  END IF;
  SELECT cron.schedule('eeum-photo-ai-v1','* * * * *',format($job$
    SELECT net.http_post(
      url := (SELECT rtrim(decrypted_secret,'/') FROM vault.decrypted_secrets WHERE name=%L)||'/functions/v1/auto-analyze-items',
      headers := jsonb_build_object('Content-Type','application/json','x-photo-ai-secret',
        (SELECT btrim(decrypted_secret) FROM vault.decrypted_secrets WHERE name=%L)),
      body := '{"dryRun":false}'::jsonb,timeout_milliseconds := 45000);
  $job$,v_url_name,v_secret_name)) INTO v_job;
  PERFORM cron.alter_job(v_job,active:=false);
END $$;
SELECT jobid,jobname,schedule,active FROM cron.job WHERE jobname='eeum-photo-ai-v1';
COMMIT;
-- 고현 수정 끝: 새 예약만 생성하며 비활성으로 설정
