// 고현 수정 시작: 생성된 단일 파일. npm SDK import는 Supabase 런타임에서 해석합니다.
// 고현 수정 시작: 기존 ai-parse 결과를 비공개 저장용 허용값으로 제한
// 프로젝트 내부 허용표입니다. 공식 기관 코드표 또는 시각적 사실 검증으로 주장하지 않습니다.
const PHOTO_PARSER_VERSION = "eeum-photo-v1";
const PHOTO_MAX_BYTES = 8_000_000;
const PHOTO_COLORS = ["검정", "흰색", "남색", "파랑", "빨강", "회색", "갈색", "분홍", "베이지"] as const;
const PHOTO_MATERIALS = ["가죽", "인조가죽", "천", "플라스틱", "금속", "고무", "실리콘", "유리", "종이", "나무"] as const;
const PHOTO_SHAPES = ["퀼팅", "꽃 장식", "리본", "지퍼", "손잡이", "키링", "카메라 렌즈", "줄무늬", "체크무늬", "격자무늬", "도트무늬", "하트무늬", "스티커", "금속 장식", "투명", "불투명", "무광", "유광", "로고", "자수", "단추"] as const;
type PhotoAnalysis = {
  parser_version: string; color: string | null; materials: string[]; shapes: string[];
  photo_features: string[]; privacy: boolean;
};
const PRIVATE_TEXT_BLOCK = /성명|이름|주소|생년|연락처|전화|주민|면허|여권|계좌|카드번호|얼굴|인물|여성|남성|남자|여자|어린이|개인정보|\d{4}|@|https?:\/\//i;
function privatePhotoFeatures(raw: unknown, privacy: boolean): string[] {
  if (privacy || !Array.isArray(raw)) return [];
  return [...new Set(raw.slice(0, 12).filter((v): v is string => typeof v === 'string')
    .map(v => v.normalize('NFKC').trim())
    .filter(v => v.length > 0 && v.length <= 80 && !/[\u0000-\u001f<>]/.test(v) && !PRIVATE_TEXT_BLOCK.test(v)))].slice(0, 4);
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function exactTags(raw: unknown, allowed: readonly string[], maximum: number): string[] {
  if (!Array.isArray(raw)) return [];
  // 부분 문자열·부정 표현·사용자 이름은 정규화하지 않습니다. 정확한 허용값만 보존합니다.
  return [...new Set(raw.slice(0, 16).filter((v): v is string => typeof v === "string" && allowed.includes(v)))].slice(0, maximum);
}
function normalizeLegacyPhotoResult(raw: unknown): PhotoAnalysis | null {
  if (!record(raw) || !Array.isArray(raw.photoFeats) || typeof raw.privacy !== "boolean") return null;
  return {
    parser_version: PHOTO_PARSER_VERSION,
    color: typeof raw.color === "string" && (PHOTO_COLORS as readonly string[]).includes(raw.color) ? raw.color : null,
    materials: exactTags(raw.photoFeats, PHOTO_MATERIALS, 3),
    shapes: exactTags(raw.photoFeats, PHOTO_SHAPES, 4),
    photo_features: privatePhotoFeatures(raw.photoFeats, raw.privacy),
    privacy: raw.privacy,
  };
}
type Failure = { action: "retry" | "failed" | "skipped" | "paused"; reason: string };
function classifyPhotoFailure(status: number, reason: unknown): Failure {
  const code = typeof reason === "string" && /^(?:[a-z][a-z0-9_]{0,63})$/.test(reason) ? reason : "unexpected_ai_response";
  if (status >= 400 && status < 500 && ![408, 429].includes(status) || /^(no_api_key|no_model|staff_|origin_not_allowed|ai_contract_mismatch|image_host_not_allowed)/.test(code) ||
      /^gemini_http_4(?!08|29)\d\d$/.test(code)) return { action: "paused", reason: code };
  if (/^(bad_image|bad_image_type|image_download_too_large|image_too_large|invalid_photo_path|image_redirect_blocked|image_too_many_redirects)$/.test(code) ||
      /^image_http_4(?!08|29)\d\d$/.test(code)) return { action: "skipped", reason: code };
  if (status === 429 || status >= 500 && !["blocked", "no_json", "max_tokens"].includes(code) ||
      /^(timeout|network|image_fetch_failed|image_http_408|image_http_429)$/.test(code)) return { action: "retry", reason: code };
  return { action: "failed", reason: code };
}
function storagePhotoURL(base: string, itemId: string, path: string): string | null {
  let origin: URL;
  try { origin = new URL(base); } catch { return null; }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.port || origin.pathname !== "/" || origin.search || origin.hash) return null;
  const prefix = `${origin.origin}/storage/v1/object/public/item-photos/`;
  const object = path.startsWith(prefix) ? path.slice(prefix.length) : path;
  if (!["jpg", "jpeg", "png", "webp"].some(ext => object === `api/${itemId}.${ext}`) || !/^(?:(?:POL|POR)-[A-Za-z0-9]+-[0-9]+|[PFB][0-9]{13,})$/.test(itemId)) return null;
  return prefix + object;
}
// 고현 수정 끝: 기존 ai-parse 결과를 비공개 저장용 허용값으로 제한

// 고현 수정 시작: 인증·Dry Run·선점·기존 AI 호출·비공개 저장 작업자

type RPCResult = { data: unknown; error: { code?: string } | null };
type WorkerDB = { rpc(name: string, parameters?: Record<string, unknown>): PromiseLike<RPCResult> };
type WorkerOptions = {
  base: string; serviceKey: string; secret: string; db: WorkerDB;
  fetcher?: typeof fetch; timeoutMs?: number;
};
type Job = { item_id: string; photo_path: string; source_version: string; lease_id: string; expected_bytes: number; expected_mime: string };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
});
function equalSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0; for (let n = 0; n < a.length; n++) diff |= a.charCodeAt(n) ^ b.charCodeAt(n);
  return diff === 0;
}
function jobValue(value: unknown): Job | null {
  if (!record(value) || typeof value.item_id !== "string" || typeof value.photo_path !== "string" ||
      typeof value.source_version !== "string" || !/^[a-f0-9]{32}$/.test(value.source_version) ||
      typeof value.lease_id !== "string" || !/^[a-f0-9-]{36}$/.test(value.lease_id) ||
      typeof value.expected_bytes !== "number" || !Number.isInteger(value.expected_bytes) ||
      value.expected_bytes < 100 || value.expected_bytes > 8_000_000 || typeof value.expected_mime !== "string") return null;
  return value as Job;
}
function createPhotoWorker(options: WorkerOptions): (request: Request) => Promise<Response> {
  return async request => {
    if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
    if (options.secret.length < 32 || !equalSecret(request.headers.get("x-photo-ai-secret") || "", options.secret)) return json(403, { error: "forbidden" });
    if (!options.base || !options.serviceKey) return json(503, { error: "server_config_missing" });
    if (Number(request.headers.get("content-length") || 0) > 2048) return json(413, { error: "body_too_large" });
    let body: Record<string, unknown>;
    try {
      const raw = await request.text();
      if (raw.length > 2048) return json(413, { error: "body_too_large" });
      const value = raw.trim() ? JSON.parse(raw) : {};
      if (!record(value)) return json(400, { error: "bad_json" });
      body = value;
    } catch { return json(400, { error: "bad_json" }); }
    if (body.dryRun !== undefined && typeof body.dryRun !== "boolean") return json(400, { error: "bad_dry_run" });
    if (body.itemId !== undefined && (typeof body.itemId !== "string" || !/^(?:(?:POL|POR)-[A-Za-z0-9]+-[0-9]+|[PFB][0-9]{13,})$/.test(body.itemId))) return json(400, { error: "bad_item_id" });
    try {
      // 빈 Test 요청은 조회만 합니다. 실행하려면 dryRun:false를 명시합니다.
      if (body.dryRun !== false) {
        const status = await options.db.rpc("eeum_photo_ai_status");
        return status.error ? json(503, { error: "database_setup_required" }) : json(200, { dryRun: true, processed: 0, status: status.data });
      }
      const claim = await options.db.rpc("eeum_photo_ai_claim", { p_item_id: body.itemId ?? null });
      if (claim.error) return json(503, { error: "claim_failed" });
      if (!record(claim.data)) return json(502, { error: "claim_contract_mismatch" });
      if (!claim.data.job) return json(200, { processed: 0, reason: claim.data.reason });
      const job = jobValue(claim.data.job);
      if (!job) return json(502, { error: "claim_contract_mismatch" });
      const finish = async (action: string, result: unknown = null, reason: string | null = null) => {
        const args = { p_item_id: job.item_id, p_lease_id: job.lease_id, p_source_version: job.source_version,
          p_action: action, p_result: result, p_reason: reason };
        // 저장 RPC만 재전송합니다. 저장 장애로 같은 사진의 Gemini를 다시 호출하지 않습니다.
        for (let attempt = 0; attempt < 2; attempt++) {
          const value = await options.db.rpc("eeum_photo_ai_finish", args);
          if (!value.error && record(value.data)) return value.data;
        }
        return null;
      };
      const image = storagePhotoURL(options.base, job.item_id, job.photo_path);
      if (!image) {
        const done = await finish("skipped", null, "invalid_photo_path");
        return json(done ? 200 : 503, { processed: 1, committed: done?.committed === true, state: done?.state || "finish_unavailable" });
      }
      let status = 502; let payload: unknown = { reason: "network" };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 31_000);
      try {
        const response = await (options.fetcher ?? fetch)(`${options.base.replace(/\/$/, "")}/functions/v1/ai-parse`, {
          method: "POST", signal: controller.signal,
          headers: { authorization: `Bearer ${options.serviceKey}`, apikey: options.serviceKey, "Content-Type": "application/json" },
          body: JSON.stringify({ mode: "register", text: "습득물 사진의 외형 특징을 확인합니다.",
            imageUrl: image + '?version=' + encodeURIComponent(job.source_version) }),
        });
        status = response.status;
        payload = await response.json();
      } catch (error) {
        status = controller.signal.aborted ? 504 : 502;
        payload = { reason: error instanceof Error && error.name === "AbortError" || controller.signal.aborted ? "timeout" : "network" };
      } finally { clearTimeout(timer); }
      const analysis = status === 200 && record(payload) ? normalizeLegacyPhotoResult(payload.result) : null;
      let done: Record<string, unknown> | null;
      if (analysis) {
        done = await finish("succeeded", analysis);
      } else {
        const reason = status === 200 ? "ai_contract_mismatch" : record(payload) ? payload.reason : undefined;
        const failure = classifyPhotoFailure(status, reason);
        done = await finish(failure.action, null, failure.reason);
      }
      // committed:false를 성공으로 표시하지 않습니다. 사진·lease 변경을 구분합니다.
      return json(done ? 200 : 503, { processed: 1, committed: done?.committed === true, state: done?.state || "finish_unavailable" });
    } catch {
      // 입력·URL·키·AI 자유 문장을 응답에 넣지 않습니다. 임대 만료 후 DB가 복구합니다.
      return json(503, { error: "worker_unavailable" });
    }
  };
}
// 고현 수정 끝: 인증·Dry Run·선점·기존 AI 호출·비공개 저장 작업자

// 고현 수정 시작: 자동 작업자 진입점. verify_jwt=false + 전용 서버 Secret 인증.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";

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

// 고현 수정 끝: 생성된 단일 파일
