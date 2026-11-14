-- 고현 수정 시작: 승인 후 기존 사진 큐 등록. AI를 호출하지 않습니다.
-- 파일럿 검증 후 실행합니다. 기존 처리/실패 상태와 원본 데이터는 초기화하지 않습니다.
-- has_more=true이면 반환된 after_id로 다음 배치를 호출합니다. 최대 1000행입니다.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='30s';
SELECT public.eeum_photo_ai_backfill(NULL,1000);
COMMIT;
-- 고현 수정 끝: 승인 후 기존 사진 큐 등록
