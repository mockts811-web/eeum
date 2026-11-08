-- =========================================================
-- 유실물 e음 · 4단계 (선택): 자동 작업 예약
-- Edge Function 배포 후 실행하세요. 시각은 UTC 기준입니다 (한국 = UTC+9).
-- =========================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 함수 주소와 cron 비밀값을 Vault에 저장 (값 두 개를 바꿔서 실행)
select vault.create_secret('https://<프로젝트ref>.supabase.co', 'project_url');
select vault.create_secret('<CRON_SECRET과 같은 값>', 'cron_secret');

-- 1) 매일 00:05 (한국) 습득 7일 지난 지하철·버스 물품을 '경찰서이관'으로
select cron.schedule('transfer-to-police', '5 15 * * *', $$
  update public.items
     set status = '경찰서이관'
   where status = '보관중'
     and kind <> '경찰서'
     and found_on < (now() at time zone 'Asia/Seoul')::date - 7;
$$);

-- 2) 매일 09:00 · 18:00 (한국) 비슷한 물건 알림 확인
select cron.schedule('match-alerts', '0 0,9 * * *', $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/match-alerts',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body    := '{}'::jsonb);
$$);

-- 확인 / 해제
-- select jobname, schedule, active from cron.job;
-- select cron.unschedule('match-alerts');
