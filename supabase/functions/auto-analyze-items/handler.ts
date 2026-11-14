// 고현 수정 시작: 인증·Dry Run·선점·기존 AI 호출·비공개 저장 작업자
import { classifyPhotoFailure, record, storagePhotoURL, normalizeLegacyPhotoResult } from "../_shared/photo-analysis.ts";
type RPCResult = { data: unknown; error: { code?: string } | null };
export type WorkerDB = { rpc(name: string, parameters?: Record<string, unknown>): PromiseLike<RPCResult> };
export type WorkerOptions = {
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
export function createPhotoWorker(options: WorkerOptions): (request: Request) => Promise<Response> {
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
