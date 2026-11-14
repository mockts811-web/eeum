-- 고현 수정 시작: 별도 승인된 정확한 물품 1건만 활성화합니다.
-- 아래 ID를 승인된 실제 ID로 바꿉니다. 자동 후보 선택은 하지 않습니다.
-- 이 SQL은 분석 호출이 아니라 설정/큐 등록만 합니다. Cron은 계속 비활성입니다.
SELECT public.eeum_photo_ai_configure('pilot','REPLACE_WITH_APPROVED_ITEM_ID',3);
-- Edge Function Test POST: {"dryRun":false,"itemId":"동일하게_승인된_ID"}
-- 인증 헤더 x-photo-ai-secret에는 PHOTO_AI_WORKER_SECRET을 사용하며 채팅/SQL에는 값을 넣지 않습니다.
-- 확인: SELECT public.eeum_photo_ai_status();
-- 고현 수정 끝: 별도 승인된 정확한 물품 1건만 활성화
