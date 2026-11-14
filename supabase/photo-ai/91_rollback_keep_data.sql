-- 고현 수정 시작: 데이터 보존형 롤백. 90_pause.sql을 먼저 별도로 실행합니다.
-- 요청 중 작업의 완료 또는 lease 만료 후 적용합니다. 새 테이블/결과/RPC도 삭제하지 않습니다.
BEGIN;
SET LOCAL lock_timeout='3s';
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM eeum_photo_ai.control WHERE singleton AND (mode<>'off' OR active_until>clock_timestamp())) THEN
    RAISE EXCEPTION 'pause_and_wait_for_active_worker_first';
  END IF;
  IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.items'::regclass
    AND tgname='trg_eeum_photo_ai_items' AND tgfoid<>'eeum_photo_ai.items_changed()'::regprocedure) THEN
    RAISE EXCEPTION 'trigger_ownership_mismatch';
  END IF;
END $$;
DROP TRIGGER IF EXISTS trg_eeum_photo_ai_items ON public.items;
-- 기존 수동 사진 분석 함수와 화면은 원래대로 유지됩니다.
-- 기존 items_touch, 기존 스키마/RLS/권한, item_private 메모는 변경하지 않습니다.
COMMIT;
-- 고현 수정 끝: 데이터 보존형 롤백
