// 고현 수정 시작: 기존 ai-parse 결과를 비공개 저장용 허용값으로 제한
// 프로젝트 내부 허용표입니다. 공식 기관 코드표 또는 시각적 사실 검증으로 주장하지 않습니다.
export const PHOTO_PARSER_VERSION = "eeum-photo-v1";
export const PHOTO_MAX_BYTES = 8_000_000;
export const PHOTO_COLORS = ["검정", "흰색", "남색", "파랑", "빨강", "회색", "갈색", "분홍", "베이지"] as const;
export const PHOTO_MATERIALS = ["가죽", "인조가죽", "천", "플라스틱", "금속", "고무", "실리콘", "유리", "종이", "나무"] as const;
export const PHOTO_SHAPES = ["퀼팅", "꽃 장식", "리본", "지퍼", "손잡이", "키링", "카메라 렌즈", "줄무늬", "체크무늬", "격자무늬", "도트무늬", "하트무늬", "스티커", "금속 장식", "투명", "불투명", "무광", "유광", "로고", "자수", "단추"] as const;
export type PhotoAnalysis = {
  parser_version: string; color: string | null; materials: string[]; shapes: string[];
  photo_features: string[]; privacy: boolean;
};
const PRIVATE_TEXT_BLOCK = /성명|이름|주소|생년|연락처|전화|주민|면허|여권|계좌|카드번호|얼굴|인물|여성|남성|남자|여자|어린이|개인정보|\d{4}|@|https?:\/\//i;
export function privatePhotoFeatures(raw: unknown, privacy: boolean): string[] {
  if (privacy || !Array.isArray(raw)) return [];
  return [...new Set(raw.slice(0, 12).filter((v): v is string => typeof v === 'string')
    .map(v => v.normalize('NFKC').trim())
    .filter(v => v.length > 0 && v.length <= 80 && !/[\u0000-\u001f<>]/.test(v) && !PRIVATE_TEXT_BLOCK.test(v)))].slice(0, 4);
}
export const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export function exactTags(raw: unknown, allowed: readonly string[], maximum: number): string[] {
  if (!Array.isArray(raw)) return [];
  // 부분 문자열·부정 표현·사용자 이름은 정규화하지 않습니다. 정확한 허용값만 보존합니다.
  return [...new Set(raw.slice(0, 16).filter((v): v is string => typeof v === "string" && allowed.includes(v)))].slice(0, maximum);
}
export function normalizeLegacyPhotoResult(raw: unknown): PhotoAnalysis | null {
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
export type Failure = { action: "retry" | "failed" | "skipped" | "paused"; reason: string };
export function classifyPhotoFailure(status: number, reason: unknown): Failure {
  const code = typeof reason === "string" && /^(?:[a-z][a-z0-9_]{0,63})$/.test(reason) ? reason : "unexpected_ai_response";
  if (status >= 400 && status < 500 && ![408, 429].includes(status) || /^(no_api_key|no_model|staff_|origin_not_allowed|ai_contract_mismatch|image_host_not_allowed)/.test(code) ||
      /^gemini_http_4(?!08|29)\d\d$/.test(code)) return { action: "paused", reason: code };
  if (/^(bad_image|bad_image_type|image_download_too_large|image_too_large|invalid_photo_path|image_redirect_blocked|image_too_many_redirects)$/.test(code) ||
      /^image_http_4(?!08|29)\d\d$/.test(code)) return { action: "skipped", reason: code };
  if (status === 429 || status >= 500 && !["blocked", "no_json", "max_tokens"].includes(code) ||
      /^(timeout|network|image_fetch_failed|image_http_408|image_http_429)$/.test(code)) return { action: "retry", reason: code };
  return { action: "failed", reason: code };
}
export function storagePhotoURL(base: string, itemId: string, path: string): string | null {
  let origin: URL;
  try { origin = new URL(base); } catch { return null; }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.port || origin.pathname !== "/" || origin.search || origin.hash) return null;
  const prefix = `${origin.origin}/storage/v1/object/public/item-photos/`;
  const object = path.startsWith(prefix) ? path.slice(prefix.length) : path;
  if (!["jpg", "jpeg", "png", "webp"].some(ext => object === `api/${itemId}.${ext}`) || !/^(?:(?:POL|POR)-[A-Za-z0-9]+-[0-9]+|[PFB][0-9]{13,})$/.test(itemId)) return null;
  return prefix + object;
}
// 고현 수정 끝: 기존 ai-parse 결과를 비공개 저장용 허용값으로 제한
