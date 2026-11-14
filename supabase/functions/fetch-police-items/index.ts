// supabase/functions/fetch-police-items/index.ts
// 경찰청 API + 포털기관 API의 습득물을 public.items에 수집합니다.
// Edge Function Secrets: POLICE_API_KEY, PORTAL_API_KEY, CRON_SECRET
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY는 Supabase 런타임 기본 환경변수입니다.

import { createClient } from "npm:@supabase/supabase-js@2";

const POLICE_BASE = "https://apis.data.go.kr/1320000/LosfundInfoInqireService";
const PORTAL_BASE = "https://apis.data.go.kr/1320000/LosPtfundInfoInqireService";
const NO_IMAGE_URL = "https://xhvthvxpwlaecizqlrrv.supabase.co/storage/v1/object/public/item-photos/no_image.jpeg";
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
// 실제 사진 URL만 사용하고, API의 기본 이미지 주소는 사진으로 취급하지 않습니다.
function isRealPhotoUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) && !/(?:no_img\.gif|no_image\.jpeg)/i.test(value);
}

const PHOTO_BUCKET = "item-photos";
const MAX_PHOTO_BYTES = 40 * 1024 * 1024;

function extOf(contentType: string): string {
  if (/png/i.test(contentType)) return "png";
  if (/gif/i.test(contentType)) return "gif";
  if (/webp/i.test(contentType)) return "webp";
  return "jpg";
}

async function mirrorPhoto(
  db: ReturnType<typeof createClient>,
  url: string,
  itemId: string,
): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Referer": "https://www.lost112.go.kr/",
        "Accept": "image/*",
      },
      signal: AbortSignal.timeout(20000),
    });

    const contentType = res.headers.get("content-type") ?? "";

    if (!res.ok || !contentType.startsWith("image/")) {
      console.log("사진 다운로드 실패:", url, res.status, contentType);
      return null;
    }

    const bytes = new Uint8Array(await res.arrayBuffer());

    if (bytes.length < 100 || bytes.length > MAX_PHOTO_BYTES) {
   console.log(
    "사진 크기 검사 실패:",
    url,
    "실제 크기:", bytes.length,
    "허용 크기:", MAX_PHOTO_BYTES,
    "Content-Type:", contentType
   );
   return null;
   }

    const path = `api/${itemId}.${extOf(contentType)}`;

    const { error } = await db.storage
      .from(PHOTO_BUCKET)
      .upload(path, bytes, {
        contentType,
        upsert: true,
      });

    if (error) {
      console.log("사진 업로드 실패:", path, error.message);
      return null;
    }

    return path;
  } catch (e) {
    console.log("사진 복사 오류:", url, String(e));
    return null;
  }
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
// 서울 시내버스 운영기관 화이트리스트 (64개사)
const SEOUL_BUS_OPERATORS: string[] = [
  "경성여객", "공항버스", "관악교통", "군포교통", "김포교통", "남성버스", "다모아자동차", "대성운수",
  "대원교통", "대원여객", "대진여객", "대흥교통", "도선여객", "도원교통", "동성교통", "동아운수",
  "동해운수", "메트로버스", "범일운수", "보광교통", "보광운수", "보성운수", "보영운수", "북부운수",
  "삼성여객", "삼양교통", "삼화상운", "상진운수", "서부운수", "서울교통네트웍", "서울매일버스", "서울버스",
  "서울승합", "선일교통", "선진운수", "세풍운수", "송파상운", "신길교통", "신수교통", "신인운수",
  "신촌교통", "신흥운수", "아진교통", "양천운수", "영신여객", "영인운수", "우신버스", "우신운수",
  "원버스", "유성운수", "정평운수", "중부운수", "진아교통", "진화운수", "태릉교통", "태진운수",
  "한국brt자동차", "한남버스", "한남여객", "한서교통", "한성여객", "한성운수", "현대교통", "흥안운수",
];

// 기관명 정규화
function normalizeOrgName(name: string): string {
  return name
    .replace(/\s*\(?0\d{1,2}[-\s)]?\d{3,4}[-\s]?\d{4}\)?\s*$/, "")
    .replace(/\(주\)|㈜|주식회사|\(유\)|유한회사|\(합\)|합자회사/g, "")
    .replace(/[\s()\[\]·.,\-]/g, "")
    .toLowerCase();
}

// 운영기관 이름 비교
function matchesOperator(orgName: string, operators: string[]): boolean {
  const org = normalizeOrgName(orgName);

  return operators.some(op => {
    const target = normalizeOrgName(op);
    if (target.length < 3) return false;

    let idx = org.indexOf(target);

    while (idx !== -1) {
      if (idx === 0 || !/[가-힣]/.test(org[idx - 1])) return true;
      idx = org.indexOf(target, idx + 1);
    }

    return false;
  });
}
function portalKind(org: string, place: string): "지하철" | "버스" | null {
  const s = `${org} ${place}`;

  // 서울 시내버스 운영기관 화이트리스트
  if (
    matchesOperator(org, SEOUL_BUS_OPERATORS) ||
    matchesOperator(place, SEOUL_BUS_OPERATORS)
  ) {
    return "버스";
  }

  if (/버스|시외버스|고속버스/i.test(s)) return "버스";

  if (/철도|지하철|역사|역(?![가-힣])|도시철도|전철|교통공사|메트로/i.test(s)) {
    return "지하철";
  }

  return null;
}
// #준희 추가 시작: 서울 외 포털기관 제외
function isOutsideSeoulPortal(...values: string[]): boolean {
  const text = values.join(" ");

  return /부산|김해|인천|대구|광주|대전|울산|세종|경기|경기도|강원|충북|충남|전북|전남|경북|경남|제주/.test(text);
}
// #준희 추가 끝
// #준희 추가 시작: 과천·광명 경찰서 제외
function isExcludedGyeonggiPolice(...values: string[]): boolean {
  const text = values.join(" ").replace(/\s+/g, "");
  return /과천|광명|별양지구대|과천지구대|광명경찰서/.test(text);
}
// #준희 추가 끝
// 서울 소재 역 화이트리스트
const SEOUL_STATIONS = new Set([
  "서울", "공덕", "홍대입구", "디지털미디어시티", "마곡나루", "김포공항",
  "남영", "용산", "노량진", "대방", "신길", "영등포", "신도림", "구로",
  "구일", "개봉", "오류동", "온수", "가산디지털단지", "독산", "금천구청",
  "청량리", "회기", "외대앞", "신이문", "석계", "광운대", "월계", "녹천",
  "창동", "방학", "도봉", "도봉산", "신촌", "가좌", "수색",
  "효창공원앞", "서강대", "이촌", "서빙고", "한남", "옥수", "응봉",
  "왕십리", "중랑", "상봉", "망우", "신내",
  "서울숲", "압구정로데오", "강남구청", "선정릉", "선릉", "한티",
  "도곡", "구룡", "개포동", "대모산입구", "수서",
  "신사", "논현", "신논현", "강남", "양재",
  "양재시민의숲", "청계산입구"
]);

// 텍스트에서 역 이름 후보를 모두 추출
function stationNames(text: string): string[] {
  const cleaned = text.replace(/\(.*?\)|\[.*?\]/g, " ");
  const fromPattern = [...cleaned.matchAll(/([가-힣0-9]+)역(?![가-힣])/g)].map(m => m[1]);
  const whole = cleaned.replace(/\s+/g, "").replace(/역$/, "");
  return [...fromPattern, whole];
}

function isSeoulStation(...texts: string[]): boolean {
  return texts.some(t => stationNames(t).some(n => SEOUL_STATIONS.has(n)));
}
// 서울 외 지역 판별
const NON_SEOUL_REGION = /경기도|강원|충청|충북|충남|전라|전북|전남|경상|제주|인천|부산|대구|대전|울산|광주|수원|고양(?!이)|용인|부천|성남(?!고)|화성|평택|의정부|파주|광명|하남|오산|이천|양주|안성|포천|의왕|여주|동두천|과천|가평|연천|일산|분당/;

const DIRECTION_PHRASE = /[가-힣]+(?:방면|방향|행)(?![가-힣])/g;

function isSeoulBus(
  orgName: string,
  place: string,
  foundPlace: string,
  tel: string
): boolean {
  const phone = tel.replace(/[^0-9]/g, "");

  // 1. 서울 외 지역번호 제외
  if (/^(031|032|033|041|042|043|044|051|052|053|054|055|061|062|063|064)/.test(phone)) {
    return false;
  }

  // 2. 서울 버스 64개사 화이트리스트
  if (
    matchesOperator(orgName, SEOUL_BUS_OPERATORS) ||
    matchesOperator(place, SEOUL_BUS_OPERATORS)
  ) {
    return true;
  }

  // 3. 기관명에 서울 외 지역명 포함 시 제외
  if (NON_SEOUL_REGION.test(orgName)) return false;

  // 4. 보관·습득 장소의 지역명 확인 (행선지는 제외)
  const placeText = `${place} ${foundPlace}`.replace(DIRECTION_PHRASE, "");

  if (NON_SEOUL_REGION.test(placeText)) return false;

  // 5. 다산콜센터
  if (normalizeOrgName(orgName).includes("다산콜")) return true;

  return false;
}
function isSeoulPortal(
  kind: "지하철" | "버스",
  orgName: string,
  place: string,
  tel: string,
  foundPlace = ""
): boolean {
  const t = tel.replace(/[^0-9]/g, "");

  // 버스는 서울 운영기관 화이트리스트로 판별
  if (kind === "버스") {
    return isSeoulBus(orgName, place, foundPlace, tel);
  }

  // 지하철 기존 판별 로직 그대로 유지
  if (t.startsWith("02")) return true;

  return isSeoulStation(orgName, place);
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

   let input: {
    startYmd?: string;
   endYmd?: string;
    numOfRows?: number;
    backfillPhotos?: boolean;
    inspectPhoto?: boolean;
    inspectId?: string;
    backfillAfterId?: string;
    policePage?: number;
    portalPage?: number;
   } = {};
  try { input = await req.json(); } catch { /* 최근 7일 기본값 */ }
  const kst = new Date(Date.now() + 9 * 3600000);
  const endDefault = kst.toISOString().slice(0, 10);
  const startDefault = new Date(kst.getTime() - 7 * 86400000).toISOString().slice(0, 10);
  const startYmd = (input.startYmd ?? startDefault).replaceAll("-", "");
  const endYmd = (input.endYmd ?? endDefault).replaceAll("-", "");
  if (!/^\d{8}$/.test(startYmd) || !/^\d{8}$/.test(endYmd) || startYmd > endYmd) {
    return json({ error: "날짜는 YYYYMMDD 형식이어야 합니다." }, 400);
  }
  const numOfRows = Math.min(Math.max(Number(input.numOfRows ?? 10), 1), 10);
    // #준희 추가 시작: 실행 시간 제한 및 페이지 시작값
   const SOURCE_RUNTIME_MS = 55_000;

   const startPages = {
   police: Math.max(1, Math.floor(input.policePage ?? 1)),
   portal: Math.max(1, Math.floor(input.portalPage ?? 1)),
   };
    // #준희 추가 끝
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
     // #준희 추가 시작: 서울 경찰서 전화번호 확인
     function isSeoulPolice(tel: string): boolean {
     const normalizedTel = tel.replace(/[^0-9]/g, "");
      return normalizedTel.startsWith("02") || normalizedTel === "182";
     }
// #준희 추가 끝
  async function getOrg(name: string, kind: "지하철" | "버스" | "경찰서", tel: string) {
    const orgName = name.trim().slice(0, 150);
    if (!orgName) return null;
    const { data: old, error: lookupError } = await db.from("orgs")
      .select("id, kind").eq("name", orgName).maybeSingle();
    if (lookupError) throw lookupError;
    if (old) return old.kind === kind ? old : null;
    const { data, error } = await db.from("orgs")
      .insert({ name: orgName, kind, tel: tel || null }).select("id, kind").single();
    if (error) {
      const { data: retry } = await db.from("orgs").select("id, kind").eq("name", orgName).maybeSingle();
      if (retry && retry.kind === kind) return retry;
      throw error;
    }
    return data;
  }

  async function collect(source: "police" | "portal", base: string, key: string, listPath: string, detailPath: string) {
    const stat = results[source];
    let page = startPages[source], total = 0;
    const sourceStartTime = Date.now();
   let hasMore = true;
   let stopForTime = false;
    do {
     if (Date.now() - sourceStartTime >= SOURCE_RUNTIME_MS) {
      stopForTime = true;
     break;
     }
      const listUrl = new URL(`${base}/${listPath}`);
      listUrl.searchParams.set("serviceKey", key);
      listUrl.searchParams.set("pageNo", String(page));
      listUrl.searchParams.set("numOfRows", String(numOfRows));
      listUrl.searchParams.set("START_YMD", startYmd);
      listUrl.searchParams.set("END_YMD", endYmd);
      const listXml = await getXml(listUrl, source);
      total = Number(xmlValue(listXml, "totalCount") || 0);
      const rows = xmlItems(listXml);
      if (!rows.length) {
     hasMore = false;
     break;
     }
      for (const row of rows) {
        if (Date.now() - sourceStartTime >= SOURCE_RUNTIME_MS) {
       stopForTime = true;
       break;
       }
        stat.fetched++;
        const atcId = xmlValue(row, "atcId");
        const fdSn = xmlValue(row, "fdSn"); // 목록에 나온 순번 그대로 사용
        const name = xmlValue(row, "fdPrdtNm") || "물품명 미상";
        const categoryRaw = xmlValue(row, "prdtClNm");
        const foundOn = xmlValue(row, "fdYmd");
        const depPlace = xmlValue(row, "depPlace");
        const subject = xmlValue(row, "fdSbjt");
        const colorRaw = xmlValue(row, "clrNm");
        if (!atcId || !fdSn || !validDate(foundOn)) { stat.skipped++; continue; }
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
          // #준희 수정 시작: 실제 사진 URL이 없으면 기본 이미지 URL을 저장
          const apiPhotoUrl =
         xmlValue(detail, "fdFilePathImg") ||
         xmlValue(row, "fdFilePathImg");

          // #준희 수정 끝
          // #준희 수정 시작: 서울 외 경찰서 데이터 수집 제외
          const kind = source === "police" ? "경찰서" : portalKind(orgName, detailPlace);

         if (!kind) {
         stat.skipped++;
         console.log("종류 판별 불가 제외:", orgName, detailPlace, tel);
         continue;
         }
          // #준희 추가 시작: 과천·광명 경찰서 수집 제외
          if (
          source === "police" &&
         isExcludedGyeonggiPolice(orgName, detailPlace, foundPlace)
         ) {
        stat.skipped++;
        console.log("과천·광명 경찰서 제외:", orgName, detailPlace, foundPlace);
       continue;
       }
        // #준희 추가 끝
         if (source === "police" && !isSeoulPolice(tel)) {
         stat.skipped++;
         continue;
         }
         // #준희 추가 시작: 서울 외 포털기관 제외

         if (
         source === "portal" &&
         !isSeoulPortal(
          kind as "지하철" | "버스",
         orgName,
         detailPlace,
          tel,
          foundPlace
         )
         ) {
         stat.skipped++;
         console.log(
          "서울 외 포털기관 제외:",
         orgName,
         detailPlace,
         foundPlace,
         tel
         );
         continue;
          }

         // #준희 추가 끝
         // #준희 수정 끝
          const org = await getOrg(orgName, kind, tel);
          if (!org) { stat.skipped++; stat.errors.push(`${atcId}/${fdSn}: 기관 종류 불일치`); continue; }
          const parts = categoryRaw.split(">").map(v => v.trim());
          const category = categoryOf(parts[0] || name, name);
          const id = `${source === "police" ? "POL" : "POR"}-${atcId}-${fdSn}`;


// 실제 사진이 있을 때만 Supabase Storage로 복사
const photoPath = isRealPhotoUrl(apiPhotoUrl)
  ? (await mirrorPhoto(db, apiPhotoUrl, id)) ?? apiPhotoUrl
  : NO_IMAGE_URL;
          const item = {
            id, kind, name: name.slice(0, 200), category,
            sub_category: parts[1] || null, color: colorOf(colorRaw), found_on: foundOn,
            line: null, found_place: foundPlace.slice(0, 200) || null, org_id: org.id,
            // #준희 수정 시작: 사진 URL을 photo_path에 저장
            description: subject.slice(0, 400) || null,
            photo_path: photoPath,
            // #준희 수정 끝
            valuable: ["지갑", "휴대폰", "이어폰"].includes(category),
            status: /수령|반환|완료|종결/.test(statusText) ? "수령완료" : "보관중",
            created_by: null,
          };
          const { error } = await db.from("items").upsert(item, { onConflict: "id", ignoreDuplicates: true });
          if (error) throw error;
          stat.saved++;
        } catch (e) { stat.errors.push(`${atcId}/${fdSn}: ${String(e).slice(0, 160)}`); }
      }
      if (stopForTime) break;
      page++;
     } while ((page - 1) * numOfRows < total);
     return {
     nextPage: stopForTime || (hasMore && (page - 1) * numOfRows < total)
     ? page
      : null,
     total
    };
     }

  // #준희 추가 시작: 기존 DB 물품 중 사진 URL이 비어 있는 항목을 10개씩 보완
  async function backfillExistingPhotos() {
    // NULL 및 경찰청 기본 이미지(no_img.gif)만 조회합니다.
    // Supabase no_image.jpeg는 이미 표준 기본 이미지이므로 다시 조회하지 않습니다.
    let query = db.from("items")
      .select("id")
      .or("photo_path.is.null,photo_path.ilike.%no_img.gif%,photo_path.ilike.%lost112%");
    if (input.backfillAfterId) query = query.gt("id", input.backfillAfterId);
    const { data: targets, error: selectError } = await query
      .order("id", { ascending: true })
      .limit(10);
    if (selectError) throw selectError;

    let updated = 0, noPhoto = 0, skipped = 0;
    const errors: string[] = [];
    for (const target of targets ?? []) {
      // #준희 수정 시작: 신규 ID(POL/POR)와 기존 ID(P/F/B) 형식 모두 처리
      const itemId = String(target.id);
      const modernMatch = itemId.match(/^(POL|POR)-(.+)-(\d+)$/);
      const legacyMatch = itemId.match(/^([PFB])(\d{12})(\d+)$/);

      let source: "police" | "portal";
      let atcId: string;
      let fdSn: string;

      if (modernMatch) {
        source = modernMatch[1] === "POL" ? "police" : "portal";
        atcId = modernMatch[2];
        fdSn = modernMatch[3];
      } else if (legacyMatch) {
        // 기존 DB의 P=경찰서, F=지하철, B=버스 ID 규칙
        source = legacyMatch[1] === "P" ? "police" : "portal";
        atcId = legacyMatch[2];
        fdSn = legacyMatch[3];
      } else {
        skipped++;
        errors.push(`${target.id}: 지원하지 않는 물품 ID 형식`);
        continue;
      }
      // #준희 수정 끝

      const base = source === "police" ? POLICE_BASE : PORTAL_BASE;
      const key = source === "police" ? policeKey : portalKey;
      const detailPath = source === "police" ? "getLosfundDetailInfo" : "getPtLosfundDetailInfo";
      try {
        const detailUrl = new URL(`${base}/${detailPath}`);
        detailUrl.searchParams.set("serviceKey", key);
        detailUrl.searchParams.set("ATC_ID", atcId);
        detailUrl.searchParams.set("FD_SN", fdSn);
        const detailXml = await getXml(detailUrl, source);
        const detail = xmlItems(detailXml)[0] ?? detailXml;
        const returnedId = xmlValue(detail, "atcId");
        const returnedSn = xmlValue(detail, "fdSn");
        if ((returnedId && returnedId !== atcId) || (returnedSn && returnedSn !== fdSn)) {
          skipped++;
          errors.push(`${target.id}: 상세조회 식별번호 불일치`);
          continue;
        }
        // #준희 추가 시작: 기존 물품 사진 보완 시 서울 외 경찰서 제외
       const tel = xmlValue(detail, "tel");
       if (
       source === "police" &&
       isExcludedGyeonggiPolice(
        xmlValue(detail, "orgNm"),
       xmlValue(detail, "depPlace"),
       xmlValue(detail, "fdPlace")
       )
       ) {
       skipped++;
       errors.push(`${target.id}: 과천·광명 경찰서 사진 보완 제외`);
       continue;
       }
       if (source === "police" && !isSeoulPolice(tel)) {
       skipped++;
       errors.push(`${target.id}: 서울 외 경찰서 사진 보완 제외`);
       continue;
       }
// #준희 추가 끝
        const apiPhotoUrl = xmlValue(detail, "fdFilePathImg");

        // 실제 사진이 있으면 실제 URL을 저장하고,
        // 사진이 없거나 API 기본 이미지면 Supabase 기본 이미지로 통일합니다.
        // 현재 값이 NULL 또는 경찰청 기본 이미지인 경우에만 갱신해 실제 사진을 덮어쓰지 않습니다.
        const mirroredPath = isRealPhotoUrl(apiPhotoUrl)
        ? await mirrorPhoto(db, apiPhotoUrl, target.id)
       : null;

       if (isRealPhotoUrl(apiPhotoUrl) && !mirroredPath) {
       skipped++;
       errors.push(`${target.id}: 사진 Storage 복사 실패`);
       continue;
       }

      const nextPhotoUrl = mirroredPath ?? NO_IMAGE_URL;
        const { error: updateError } = await db.from("items")
          .update({ photo_path: nextPhotoUrl })
          .eq("id", target.id)
          .or("photo_path.is.null,photo_path.ilike.%no_img.gif%,photo_path.ilike.%lost112%");
        if (updateError) throw updateError;
        if (isRealPhotoUrl(apiPhotoUrl)) updated++;
        else noPhoto++;
      } catch (e) {
        skipped++;
        errors.push(`${target.id}: ${String(e).slice(0, 150)}`);
      }
    }
    const { count: remaining, error: countError } = await db.from("items")
      .select("id", { count: "exact", head: true })
      .or("photo_path.is.null,photo_path.ilike.%no_img.gif%,photo_path.ilike.%lost112%");
    if (countError) throw countError;
    return {
      selected: targets?.length ?? 0,
      updated,
      noPhoto,
      skipped,
      remaining: remaining ?? null,
      nextAfterId: (targets?.length ?? 0) === 10
        ? String(targets[targets.length - 1].id)
        : null,
      errors,
    };
  }
  // #준희 추가 끝

  try {
    // #준희 추가 시작: backfillPhotos=true 요청이면 기존 데이터 사진 보완만 실행
    if (input.inspectPhoto === true) {
  const id = input.inspectId ?? "";
  const match = id.match(/^(POL|POR)-(.+)-(\d+)$/);

  if (!match) {
    return json({ error: "물품 ID 형식이 올바르지 않습니다." }, 400);
  }

  const source = match[1] === "POL" ? "police" : "portal";
  const base = source === "police" ? POLICE_BASE : PORTAL_BASE;
  const key = source === "police" ? policeKey : portalKey;
  const detailPath = source === "police"
    ? "getLosfundDetailInfo"
    : "getPtLosfundDetailInfo";

  const url = new URL(`${base}/${detailPath}`);
  url.searchParams.set("serviceKey", key);
  url.searchParams.set("ATC_ID", match[2]);
  url.searchParams.set("FD_SN", match[3]);

  const xml = await getXml(url, source);
  const detail = xmlItems(xml)[0] ?? xml;

  return json({
    id,
    source,
    atcId: xmlValue(detail, "atcId"),
    fdSn: xmlValue(detail, "fdSn"),
    fdFilePathImg: xmlValue(detail, "fdFilePathImg"),
    imageIsReal: isRealPhotoUrl(xmlValue(detail, "fdFilePathImg"))
  });
}
    if (input.backfillPhotos === true) {
      const backfill = await backfillExistingPhotos();
      return json({ ok: true, mode: "photo_backfill", backfill });
    }
    // #준희 추가 끝
    const policeProgress = await collect(
    "police",
    POLICE_BASE,
    policeKey,
    "getLosfundInfoAccToClAreaPd",
   "getLosfundDetailInfo"
   );

   const portalProgress = await collect(
   "portal",
   PORTAL_BASE,
   portalKey,
   "getPtLosfundInfoAccToClAreaPd",
   "getPtLosfundDetailInfo"
    );
    return json({
  ok: true,
  range: { startYmd, endYmd },
  results,
  nextPages: {
    police: policeProgress.nextPage,
    portal: portalProgress.nextPage
   },
  note: "다음 페이지 번호가 있으면 해당 페이지부터 이어서 수집할 수 있습니다."
   });
   } catch (e) {
    console.error(e);
    return json({ ok: false, error: String(e), results }, 500);
  }
});
