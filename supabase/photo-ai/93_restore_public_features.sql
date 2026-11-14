-- 고현 수정 시작: 사진 특징 추가와 문장 정리를 조건부 복구. 90_pause.sql을 먼저 실행합니다.
-- 담당자가 설명을 변경한 행은 건너뜁니다. 원본·비공개 결과·복구 이력은 삭제하지 않습니다.
BEGIN;
SET LOCAL lock_timeout='3s';
SELECT public.eeum_photo_ai_restore_public();
COMMIT;
-- 고현 수정 끝: 사진 특징 추가와 문장 정리를 조건부 복구
