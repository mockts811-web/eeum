// supabase/functions/fetch-police-items/index.ts
// 경찰청 API + 포털기관 API의 습득물을 public.items에 수집합니다.
// Edge Function Secrets: POLICE_API_KEY, PORTAL_API_KEY, CRON_SECRET
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY는 Supabase 런타임 기본 환경변수입니다.

import { createClient } from "npm:@supabase/supabase-js@2";

const POLICE_BASE = "https://apis.data.go.kr/1320000/LosfundInfoInqireService";
const PORTAL_BASE = "https://apis.data.go.kr/1320000/LosPtfundInfoInqireService";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function decodeXml(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();
}
function xmlValue(xml: string, tag: string): string {
  const safe = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = xml.match(new RegExp(`<${safe}>([\\s\\S]*?)</${safe}>`, "i"));
  return m ? decodeXml(m[1]) : "";
}
function xmlItems(xml: string): string[] {
  const body = xml.match(/<items>([\s\S]*?)<\/items>/i)?.[1] ?? "";
  return [...body.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map(m => m[1]);
}
function categoryOf(raw: string, name: string): string {
  const s = `${raw} ${name}`.toLowerCase();
  if (s.includes("지갑")) return "지갑";
  if (/휴대폰|스마트폰/.test(s)) return "휴대폰";
  if (/이어폰|에어팟|버즈/.test(s)) return "이어폰";
  if (/가방|배낭|백팩/.test(s)) return "가방";
  if (s.includes("우산")) return "우산";
  if (/의류|점퍼|옷/.test(s)) return "의류";
  if (s.includes("전자")) return "전자기기";
  return "기타";
}
function colorOf(raw: string): string | null {
  if (!raw.trim()) return null;
  if (/검정|블랙|까만/i.test(raw)) return "검정";
  if (/흰색|화이트|하얀/i.test(raw)) return "흰색";
  if (/남색|네이비/i.test(raw)) return "남색";
  if (/파랑|파란|블루/i.test(raw)) return "파랑";
  if (/빨강|빨간|레드/i.test(raw)) return "빨강";
  if (/회색|그레이|은색/i.test(raw)) return "회색";
  if (/갈색|브라운/i.test(raw)) return "갈색";
  if (/분홍|핑크/i.test(raw)) return "분홍";
  if (/베이지/i.test(raw)) return "베이지";
  return "기타";
}
function validDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status, headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}
async function getXml(url: URL, source: string): Promise<string> {
  const res = await fetch(url, { headers: { Accept: "application/xml, text/xml" } });
  const body = await res.text();
  if (!res.ok) throw new Error(`${source} API HTTP ${res.status}: ${body.slice(0, 250)}`);
  const code = xmlValue(body, "resultCode");
  if (code && code !== "00") throw new Error(`${source} API ${code}: ${xmlValue(body, "resultMsg")}`);
  return body;
}
function portalKind(org: string, place: string): "지하철" | "버스" | null {
  const s = `${org} ${place}`;
  if (/버스|시외버스|고속버스/i.test(s)) return "버스";
  if (/철도|지하철|역사|역\b|도시철도|전철/i.test(s)) return "지하철";
  return null;
}
function isSeoulOrg(
  kind: "지하철" | "버스" | "경찰서",
  tel: string
): boolean {
  const digits = tel.replace(/\D/g, "");

  if (digits.startsWith("02")) return true;
  if (kind === "경찰서" && digits === "182") return true;

  return false;
}
Deno.serve(async req => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST 요청만 허용됩니다." }, 405);
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (!cronSecret || req.headers.get("x-cron-secret") !== cronSecret) return json({ error: "forbidden" }, 403);

  const policeKey = Deno.env.get("POLICE_API_KEY");
  const portalKey = Deno.env.get("PORTAL_API_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!policeKey || !portalKey || !supabaseUrl || !serviceKey) {
    return json({ error: "POLICE_API_KEY, PORTAL_API_KEY 또는 Supabase 서버 환경변수가 없습니다." }, 500);
  }

  let input: { startYmd?: string; endYmd?: string; numOfRows?: number } = {};
  try { input = await req.json(); } catch { /* 최근 7일 기본값 */ }
  const kst = new Date(Date.now() + 9 * 3600000);
  const endDefault = kst.toISOString().slice(0, 10);
  const startDefault = new Date(kst.getTime() - 7 * 86400000).toISOString().slice(0, 10);
  const startYmd = (input.startYmd ?? startDefault).replaceAll("-", "");
  const endYmd = (input.endYmd ?? endDefault).replaceAll("-", "");
  if (!/^\d{8}$/.test(startYmd) || !/^\d{8}$/.test(endYmd) || startYmd > endYmd) {
    return json({ error: "날짜는 YYYYMMDD 형식이어야 합니다." }, 400);
  }
  const numOfRows = Math.min(Math.max(Number(input.numOfRows ?? 2), 1), 5);
  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  type SourceStats = {
    fetched: number;
    saved: number;
    skipped: number;
    errors: string[];
  };
  const results: { police: SourceStats; portal: SourceStats } = {
    police: { fetched: 0, saved: 0, skipped: 0, errors: [] },
    portal: { fetched: 0, saved: 0, skipped: 0, errors: [] },
  };

  async function getOrg(
  name: string,
  kind: "지하철" | "버스" | "경찰서",
  tel: string
) {
  const orgName = name.trim().slice(0, 150);
  if (!orgName) return null;

  const { data: old, error: lookupError } = await db
    .from("orgs")
    .select("id, kind, tel")
    .eq("name", orgName)
    .maybeSingle();

  if (lookupError) throw lookupError;

  // 기존 기관이면 저장된 전화번호를 우선 확인
  if (old) {
    if (old.kind !== kind) return null;

    const effectiveTel = old.tel || tel;
    if (!isSeoulOrg(kind, effectiveTel)) return null;

    return old;
  }

  // 신규 기관은 서울 전화번호인 경우에만 등록
  if (!isSeoulOrg(kind, tel)) return null;

  const { data, error } = await db
    .from("orgs")
    .insert({
      name: orgName,
      kind,
      tel: tel || null
    })
    .select("id, kind")
    .single();

  if (error) {
    const { data: retry } = await db
      .from("orgs")
      .select("id, kind, tel")
      .eq("name", orgName)
      .maybeSingle();

    if (
      retry &&
      retry.kind === kind &&
      isSeoulOrg(kind, retry.tel || tel)
    ) {
      return retry;
    }

    throw error;
  }

  return data;
}

  async function collect(source: "police" | "portal", base: string, key: string, listPath: string, detailPath: string) {
    const stat = results[source];
    let page = 1, total = 0, processed = 0;
    const MAX_RECORDS = 4;
    do {
      const listUrl = new URL(`${base}/${listPath}`);
      listUrl.searchParams.set("serviceKey", key);
      listUrl.searchParams.set("pageNo", String(page));
      listUrl.searchParams.set("numOfRows", String(numOfRows));
      listUrl.searchParams.set("START_YMD", startYmd);
      listUrl.searchParams.set("END_YMD", endYmd);
      const listXml = await getXml(listUrl, source);
      total = Number(xmlValue(listXml, "totalCount") || 0);
      const rows = xmlItems(listXml);
      if (!rows.length) break;
      for (const row of rows) {
        if (processed >= MAX_RECORDS) break;
        processed++;
        stat.fetched++;
        const atcId = xmlValue(row, "atcId");
        const fdSn = xmlValue(row, "fdSn"); // 목록에 나온 순번 그대로 사용
        const name = xmlValue(row, "fdPrdtNm") || "물품명 미상";
        const categoryRaw = xmlValue(row, "prdtClNm");
        const foundOn = xmlValue(row, "fdYmd");
        const depPlace = xmlValue(row, "depPlace");
        const subject = xmlValue(row, "fdSbjt");
        const colorRaw = xmlValue(row, "clrNm");
       if (!atcId || !fdSn || !validDate(foundOn)) {
        stat.skipped++;
         stat.errors.push(
        `${source}: 필수값 누락 또는 날짜 형식 오류 (atcId=${atcId}, fdSn=${fdSn}, foundOn=${foundOn})`
      );
        continue;
      }
        try {
          const detailUrl = new URL(`${base}/${detailPath}`);
          detailUrl.searchParams.set("serviceKey", key);
          detailUrl.searchParams.set("ATC_ID", atcId);
          detailUrl.searchParams.set("FD_SN", fdSn);
          const detailXml = await getXml(detailUrl, source);
          const detail = xmlItems(detailXml)[0] ?? detailXml;
          const detailAtc = xmlValue(detail, "atcId"), detailSn = xmlValue(detail, "fdSn");
          if ((detailAtc && detailAtc !== atcId) || (detailSn && detailSn !== fdSn)) {
            stat.skipped++; stat.errors.push(`${atcId}/${fdSn}: 목록·상세 식별번호 불일치`); continue;
          }
          const orgName = xmlValue(detail, "orgNm") || depPlace;
          const detailPlace = xmlValue(detail, "depPlace") || depPlace;
          const foundPlace = xmlValue(detail, "fdPlace") || detailPlace;
          const tel = xmlValue(detail, "tel");
          const statusText = xmlValue(detail, "csteSteNm");
          const kind = source === "police" ? "경찰서" : portalKind(orgName, detailPlace);

         if (!kind) {
         stat.skipped++;
          stat.errors.push(
           `${atcId}/${fdSn}: 기관 종류 판별 실패 (기관명=${orgName}, 보관장소=${detailPlace})`
          );
         continue;
         }
          const org = await getOrg(orgName, kind, tel);
          if (!org) {
          stat.skipped++;
          stat.errors.push(
         `${atcId}/${fdSn}: 기관 정보 확인 실패 (기관명=${orgName}, 종류=${kind})`
          );
  continue;
}
          const parts = categoryRaw.split(">").map(v => v.trim());
          const category = categoryOf(parts[0] || name, name);
          const id = `${source === "police" ? "POL" : "POR"}-${atcId}-${fdSn}`;
          const item = {
            id, kind, name: name.slice(0, 200), category,
            sub_category: parts[1] || null, color: colorOf(colorRaw), found_on: foundOn,
            line: null, found_place: foundPlace.slice(0, 200) || null, org_id: org.id,
            description: subject.slice(0, 400) || null, photo_path: null,
            valuable: ["지갑", "휴대폰", "이어폰"].includes(category),
            status: /수령|반환|완료|종결/.test(statusText) ? "수령완료" : "보관중",
            created_by: null,
          };
          const { error } = await db.from("items").upsert(item, { onConflict: "id", ignoreDuplicates: true });
          if (error) throw error;
          stat.saved++;
        } catch (e) { stat.errors.push(`${atcId}/${fdSn}: ${String(e).slice(0, 160)}`); }
      }
      page++;
    } while (
  (page - 1) * numOfRows < total &&
  page <= 20 &&
  processed < MAX_RECORDS
);
  }

  try {
    await collect("police", POLICE_BASE, policeKey, "getLosfundInfoAccToClAreaPd", "getLosfundDetailInfo");
    await collect("portal", PORTAL_BASE, portalKey, "getPtLosfundInfoAccToClAreaPd", "getPtLosfundDetailInfo");
    return json({ ok: true, range: { startYmd, endYmd }, results,
      note: "기관이 없으면 orgs에 추가합니다. 포털기관 API는 지하철·버스로 판별되는 기관만 저장하며, 상세 특이사항(uniq)은 저장하지 않습니다." });
  } catch (e) {
    console.error(e);
    return json({ ok: false, error: String(e), results }, 500);
  }
});
