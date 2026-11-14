-- 고현 수정 시작: 기존 Cron/Vault 이름만 확인. 예약/비밀값을 변경하거나 노출하지 않습니다.
-- 01 파일에서 cron.job과 vault.decrypted_secrets 존재 확인 후 조회합니다.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '15s';
SELECT clock_timestamp() AS observed_at, current_user AS inspection_role;
SELECT jobid, jobname, schedule, active, md5(command) AS command_md5
FROM cron.job ORDER BY jobname, jobid;
-- 총합 2개가 아니라 이름별 개수를 확인합니다. 비밀값(decrypted_secret)은 조회하지 않습니다.
SELECT name, count(*) AS entry_count
FROM vault.decrypted_secrets
WHERE name IN ('project_url','cron_secret','photo_ai_project_url','photo_ai_cron_secret')
GROUP BY name ORDER BY name;
COMMIT;
-- 고현 수정 끝: 기존 Cron/Vault 이름만 확인
