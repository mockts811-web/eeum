-- 고현 수정 시작: 보존형 롤백 후 연결만 복구. 실행 모드는 여전히 off입니다.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM eeum_photo_ai.control WHERE singleton AND mode='off') THEN RAISE EXCEPTION 'pause_first'; END IF;
  IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.items'::regclass AND tgname='trg_eeum_photo_ai_items') THEN
    RAISE EXCEPTION 'trigger_already_exists_review_owner';
  END IF;
END $$;
CREATE TRIGGER trg_eeum_photo_ai_items AFTER INSERT OR UPDATE OF photo_path,status,created_by
ON public.items FOR EACH ROW EXECUTE FUNCTION eeum_photo_ai.items_changed();
COMMIT;
-- 고현 수정 끝: 보존형 롤백 후 연결만 복구
