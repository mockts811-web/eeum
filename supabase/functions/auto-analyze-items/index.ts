// 고현 수정 시작: 자동 작업자 진입점. verify_jwt=false + 전용 서버 Secret 인증.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { createPhotoWorker } from "./handler.ts";
const base = Deno.env.get("SUPABASE_URL")?.trim().replace(/\/$/, "") || "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim() || "";
// 전용 Secret이 없으면 기존 수집 예약의 서버 Secret을 재사용합니다. 값을 출력하지 않습니다.
const secret = Deno.env.get("PHOTO_AI_WORKER_SECRET")?.trim() || Deno.env.get("CRON_SECRET")?.trim() || "";
// 잘못된 환경설정도 비밀값을 출력하지 않고 요청 시 503으로 처리합니다.
let db: ReturnType<typeof createClient> | null = null;
try {
  if (base && serviceKey) db = createClient(base, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
} catch { /* 요청 시 server_config_missing으로 처리 */ }
Deno.serve(createPhotoWorker({ base, serviceKey, secret,
  db: db ?? { rpc: () => Promise.resolve({ data: null, error: { code: "missing_config" } }) },
}));
// 고현 수정 끝: 자동 작업자 진입점
