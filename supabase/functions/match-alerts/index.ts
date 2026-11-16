import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.9.16";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

// #준희 추가 시작: Gmail SMTP(465, SSL)로 알림 메일 발송
// Supabase Edge Function은 25·587 포트를 막으므로 465 사용 (smtp-test로 동작 확인)
// Secrets: GMAIL_USER, GMAIL_APP_PASSWORD
// 동시 요청끼리 연결을 공유하지 않도록 transporter는 요청마다 새로 만들고 그 요청에서 정리
type MailTransporter = ReturnType<typeof nodemailer.createTransport>;

function createTransporter(): MailTransporter | null {
  const user = Deno.env.get("GMAIL_USER");
  const pass = Deno.env.get("GMAIL_APP_PASSWORD");
  if (!user || !pass) return null;
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user, pass },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
}

// 오류 메시지 속 이메일 주소 가리기 (서버 로그에 개인정보가 남지 않도록)
function maskEmails(text: string): string {
  return text.replace(/[^\s<>"'@]+@[^\s<>"'@]+/g, "***@***");
}

// 성공하면 null, 실패하면 개인정보 없는 오류 종류를 반환
// 성공은 Gmail SMTP가 메시지를 접수했다는 뜻이며, 수신함 도착을 뜻하지는 않음
async function sendAlertEmail(
  t: MailTransporter | null,
  to: string,
  subject: string,
  text: string,
): Promise<string | null> {
  if (!t) return "설정 누락 (GMAIL_USER 또는 GMAIL_APP_PASSWORD)";
  try {
    await t.sendMail({
      from: `유실물 e음 <${Deno.env.get("GMAIL_USER")}>`,
      to,
      subject,
      text,
    });
    return null;
  } catch (e) {
    const raw = String(e);
    console.error("SMTP 발송 오류:", maskEmails(raw).slice(0, 300));
    if (/535|auth|invalid login/i.test(raw)) return "SMTP 인증 실패 (앱 비밀번호 확인)";
    if (/timeout|ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i.test(raw)) return "SMTP 연결 실패";
    if (/55[0-4]|recipient|mailbox/i.test(raw)) return "수신 주소 거부";
    if (/421|454|limit|quota/i.test(raw)) return "발송 한도 초과 또는 일시 제한";
    return "SMTP 발송 실패 (서버 로그 확인)";
  }
}
// #준희 추가 끝

// #준희 추가 시작: 알림 조건에서 비교할 값 추출
function getConditionValue(condition: any, keys: string[]): string {
  for (const key of keys) {
    const value = condition?.[key];

    if (value !== undefined && value !== null && value !== "") {
      return Array.isArray(value) ? value.join(" ") : String(value);
    }
  }

  return "";
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function getTokens(value: string): string[] {
  return normalize(value)
    .split(/[\s,./·\-]+/)
    .filter((token) => token.length >= 2);
}

// 후보 습득물의 사전 관련성 점수 계산
// Gemini에 전달하기 전, 분류·색상·날짜·장소·특징을 기준으로 후보 우선순위를 정함
function normalizeMatchText(value: string): string {
  return normalize(value)
    .replace(/까만색|까만|검은색|검정색/g, "검정")
    .replace(/흰색|하얀색|하얀/g, "흰색")
    .replace(/에어팟|버즈/g, "무선이어폰");
}

function calculateCandidateScore(condition: any, item: any): number {
  let score = 0;

  const label = getConditionValue(condition, [
    "label", "name", "item", "물품", "찾는물건", "분실물명",
  ]);
  const category = getConditionValue(condition, [
    "category", "cat", "분류", "물품분류",
  ]);
  const color = getConditionValue(condition, ["color", "색상"]);
  const date = getConditionValue(condition, [
    "date", "lost_date", "lostDate", "분실일",
  ]);
  const line = getConditionValue(condition, ["line", "노선"]);
  const station = getConditionValue(condition, [
    "station", "역", "분실장소",
  ]);
  const features = getConditionValue(condition, [
    "feats", "features", "description", "특징", "상세설명",
  ]);

  const itemCategory = normalizeMatchText(
    `${item.category ?? ""} ${item.sub_category ?? ""}`
  );
  const wantedCategory = normalizeMatchText(category);
  const itemColor = normalizeMatchText(item.color ?? "");
  const wantedColor = normalizeMatchText(color);
  const itemText = normalizeMatchText(
    `${item.name ?? ""} ${item.description ?? ""}`
  );

  // 분류: 일치하거나 같은 의미의 표현이면 높은 우선순위
  if (wantedCategory && itemCategory) {
    if (itemCategory.includes(wantedCategory) || wantedCategory.includes(itemCategory)) {
      score += 40;
    } else if (
      getTokens(wantedCategory).some((token) => itemCategory.includes(token))
    ) {
      score += 20;
    }
  } else if (label && itemText.includes(normalizeMatchText(label))) {
    score += 20;
  }

  // 물품명 및 특징의 공통 단어
  const wantedTokens = getTokens(`${label} ${features}`);
  const itemTokens = getTokens(`${item.name ?? ""} ${item.description ?? ""}`);
  const matchedTokens = wantedTokens.filter((token) =>
    itemTokens.some((candidate) => candidate.includes(token) || token.includes(candidate))
  );
  score += Math.min(matchedTokens.length * 3, 15);

  // 색상: 같은 색상과 비슷한 색상에만 가점
  if (wantedColor && itemColor) {
    if (itemColor.includes(wantedColor) || wantedColor.includes(itemColor)) {
      score += 25;
    } else {
      const similarColorGroups = [
        ["남색", "파랑", "청색", "네이비", "블루"],
        ["회색", "은색", "실버", "그레이"],
        ["검정", "검은", "블랙"],
        ["흰색", "화이트", "아이보리"],
      ];
      const similar = similarColorGroups.some((group) =>
        group.some((a) => wantedColor.includes(a)) &&
        group.some((b) => itemColor.includes(b))
      );
      if (similar) score += 12;
    }
  }

  // 날짜: 분실일 당일·다음 날을 우선
  if (date && item.found_on) {
    const lostTime = new Date(date).getTime();
    const foundTime = new Date(item.found_on).getTime();

    if (Number.isFinite(lostTime) && Number.isFinite(foundTime)) {
      const diffDays = Math.round((foundTime - lostTime) / 86400000);
      if (diffDays === 0) score += 20;
      else if (diffDays === 1) score += 18;
      else if (diffDays > 1 && diffDays <= 3) score += 10;
      else if (diffDays > 3 && diffDays <= 7) score += 4;
    }
  }

  // 노선·역: 같은 경우에만 가점. 정보가 없거나 다른 경우 점수 변경 없음
  if (line && item.line && normalizeMatchText(item.line).includes(normalizeMatchText(line))) {
    score += 8;
  }
  if (station && item.found_place &&
      normalizeMatchText(item.found_place).includes(normalizeMatchText(station))) {
    score += 8;
  }

  return score;
}

// 관련성이 높은 습득물 최대 5개 선정
function selectTopCandidates(
  condition: any,
  items: any[],
  existingItemIds: Set<string>
): any[] {
  return items
    .filter((item) => !existingItemIds.has(item.id))
    .map((item) => ({
      item,
      relevance: calculateCandidateScore(condition, item),
    }))
    .filter((candidate) => candidate.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, 5)
    .map((candidate) => candidate.item);
}
// #준희 추가 끝

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const cronSecret = Deno.env.get("CRON_SECRET");
  const requestSecret = req.headers.get("x-cron-secret");

  if (!cronSecret || requestSecret !== cronSecret) {
    return new Response(
      JSON.stringify({ success: false, error: "Unauthorized" }),
      {
        status: 401,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  }

  // #준희 추가: 이 요청에서만 쓰는 SMTP 연결 (메일을 처음 보낼 때 생성)
  let transporter: MailTransporter | null = null;

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const geminiKey = Deno.env.get("GEMINI_API_KEY")!;
    const model = Deno.env.get("GEMINI_MODEL") || "gemini-2.5-flash";

    const db = createClient(supabaseUrl, serviceKey);

    // 알림 조건 조회
    const { data: alerts, error: alertError } = await db
      .from("alerts")
      .select("id, label, conditions, email, email_consent, last_checked_at")
      .range(0, 199);

    if (alertError) throw alertError;

    // 습득물 조회
    const { data: items, error: itemError } = await db
      .from("items")
      .select(
        "id, name, category, sub_category, color, found_on, line, found_place, description"
      )
      .order("created_at", { ascending: false })
      .range(0, 999);

    if (itemError) throw itemError;

    const results = [];

    // #준희 추가: 이메일 발송 결과 (DB 변경 없이 응답·로그로 확인)
    // emails_sent는 Gmail SMTP가 접수한 건수이며, 실제 수신함 도착 건수는 아님
    const emailFailures: { alert_id: string; item_id: string; error: string }[] = [];
    let emailsSent = 0;

    for (const alert of alerts ?? []) {
      const condition = alert.conditions ?? {};

      // #준희 추가 시작: 이미 비교한 습득물 ID 조회
      const { data: previousHits, error: hitError } = await db
        .from("alert_hits")
        .select("item_id")
        .eq("alert_id", alert.id);

      if (hitError) throw hitError;

      const existingItemIds = new Set(
        (previousHits ?? []).map((hit) => hit.item_id)
      );

      // 관련성이 높은 후보 5개 선정
      const candidates = selectTopCandidates(
        condition,
        items ?? [],
        existingItemIds
      );

      if (candidates.length === 0) {
        await db
          .from("alerts")
          .update({ last_checked_at: new Date().toISOString() })
          .eq("id", alert.id);

        continue;
      }
      // #준희 추가 끝

      // #준희 수정 시작: 후보 5개를 한 번의 Gemini 요청으로 비교
      const lostLabel = getConditionValue(condition, [
        "label", "name", "item", "물품", "찾는물건", "분실물명",
      ]) || alert.label || "";
      const lostCategory = getConditionValue(condition, [
        "category", "cat", "분류", "물품분류",
      ]);
      const lostColor = getConditionValue(condition, ["color", "색상"]);
      const lostDate = getConditionValue(condition, [
        "date", "lost_date", "lostDate", "분실일",
      ]);
      const lostLine = getConditionValue(condition, ["line", "노선"]);
      const lostStation = getConditionValue(condition, [
        "station", "역", "분실장소",
      ]);
      const lostFeatures = getConditionValue(condition, [
        "feats", "features", "description", "특징", "상세설명",
      ]);

      const candidateLines = candidates.map((item) =>
        [
          item.id,
          item.name ?? "",
          item.category ?? item.sub_category ?? "",
          item.color ?? "",
          item.found_on ?? "",
          item.found_place ?? "",
          item.description ?? "",
        ].join(" | ")
      ).join("\n");

      const prompt = `
너는 대중교통 유실물 매칭 도우미야.
시민이 잃어버린 물건과 새로 들어온 습득물 후보들을 비교해서,
각 후보가 같은 물건일 가능성을 0~1 점수로 판단해.
설명 없이 JSON 배열만 출력해.

[잃어버린 물건]
- 찾는 물건: ${lostLabel}
- 분류: ${lostCategory} / 색상: ${lostColor} / 잃어버린 날: ${lostDate}
- 노선: ${lostLine} / 역: ${lostStation} / 특징: ${lostFeatures}

[습득물 후보]
관리번호 | 물품명 | 분류 | 색상 | 습득일 | 습득 장소 | 공개 특징
${candidateLines}

[판단 기준]
- 분류가 다르면 0.2 이하
- 같은 뜻의 다른 표현은 같은 것으로 봐 (까만=검정, 에어팟=무선 이어폰)
- 색상이 다르면 크게 낮춰. 비슷한 색(남색·파랑, 회색·은색)은 조금만 낮춰
- 습득일이 잃어버린 날보다 이전이면 0.2 이하. 잃어버린 날 당일·다음 날이면 높게
- 노선·역이 같으면 높여. 경찰서로 옮겨진 물건은 노선이 비어 있을 수 있으니 감점하지 마
- 특징(재질·종류)이 겹칠수록 높여
- 적힌 정보만으로 판단하고, 없는 정보는 추측하지 마

[점수 기준]
- 0.8 이상: 거의 같은 물건 (분류·색상·날짜·특징 대부분 일치)
- 0.6~0.8: 같은 물건일 수 있음
- 0.6 미만: 다른 물건일 가능성이 큼

[출력 형식]
후보의 관리번호를 id에 그대로 사용해.
각 후보의 점수는 0~1 사이 숫자로 작성하고, reason은 시민이 읽을 한 줄 이유로 작성해.
0.6 이상인 후보만 배열에 포함해.
일치하는 후보가 없다면 빈 배열 []을 반환해.

[
  {"id":"관리번호","score":0.00,"reason":"시민이 읽을 한 줄 이유"}
]

JSON 배열 이외의 설명이나 마크다운은 출력하지 마.
`;

      // Gemini 무료 API 요청 간격 조절
      await new Promise((resolve) => setTimeout(resolve, 5000));

      let response: Response | null = null;
      let apiError = "";

      for (let attempt = 0; attempt < 2; attempt++) {
        response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                responseMimeType: "application/json",
              },
            }),
          }
        );

        if (response.ok) break;

        apiError = await response.text();

        if (response.status === 429 && attempt === 0) {
          console.log("Gemini 요청 한도 초과. 45초 후 재시도합니다.");
          await new Promise((resolve) => setTimeout(resolve, 45000));
          continue;
        }

        throw new Error(`Gemini API 오류: ${apiError}`);
      }

      if (!response || !response.ok) {
        throw new Error(`Gemini API 재시도 실패: ${apiError}`);
      }

      const aiData = await response.json();
      const rawText =
        aiData.candidates?.[0]?.content?.parts?.[0]?.text;

      if (!rawText) {
        console.error("Gemini 응답이 비어 있습니다:", alert.id);
        continue;
      }

      let matchData: any[];

      try {
        const parsed = JSON.parse(rawText);
        if (!Array.isArray(parsed)) {
          throw new Error("Gemini 응답이 JSON 배열이 아닙니다.");
        }
        matchData = parsed;
      } catch (parseError) {
        console.error("Gemini JSON 파싱 실패:", parseError, rawText);
        continue;
      }

      // 후보 ID와 실제 조회된 물품을 연결
      const candidateMap = new Map(
        candidates.map((item) => [item.id, item])
      );

      for (const match of matchData) {
        const item = candidateMap.get(match.id);
        const score = Number(match.score);

        if (!item || !Number.isFinite(score)) continue;
        if (score < 0.6 || score > 1) continue;

        // 매칭 결과 저장
        const { error: insertError } = await db
          .from("alert_hits")
          .insert({
            alert_id: alert.id,
            item_id: item.id,
            score,
          });

        if (insertError) {
          console.error("매칭 결과 저장 실패:", insertError);
          continue;
        }

        results.push({
          alert_id: alert.id,
          item_id: item.id,
          score,
          reason: match.reason,
        });

        // #준희 수정 시작: Resend 대신 Gmail SMTP로 발송, 실패하면 기록
        if (alert.email_consent === true && alert.email) {
          transporter ??= createTransporter();
          const sendError = await sendAlertEmail(
            transporter,
            alert.email,
            `[유실물 알림] ${item.name}과(와) 유사한 습득물이 발견됐어요!`,
            `유사한 습득물이 발견됐습니다.

물품명: ${item.name ?? "정보 없음"}
분류: ${item.category ?? "정보 없음"}
색상: ${item.color ?? "정보 없음"}
습득 날짜: ${item.found_on ?? "정보 없음"}
습득 장소: ${item.found_place ?? "정보 없음"}

유사도: ${Math.round(score * 100)}점

AI 판단 이유:
${match.reason ?? "정보 없음"}`
          );

          if (sendError) {
            // 매칭 기록은 이미 저장돼 자동 재발송되지 않음 → 수동 확인용으로 기록
            console.error("이메일 발송 실패 (자동 재발송 안 됨):", {
              alert_id: alert.id,
              item_id: item.id,
              error: sendError,
            });
            emailFailures.push({ alert_id: alert.id, item_id: item.id, error: sendError });
          } else {
            emailsSent++;
          }
        }
        // #준희 수정 끝
      }
      // #준희 수정 끝

      // 비교 완료 시간 기록
      await db
        .from("alerts")
        .update({ last_checked_at: new Date().toISOString() })
        .eq("id", alert.id);
    }

    return new Response(
      JSON.stringify({
        success: true,
        checked_alerts: alerts?.length ?? 0,
        checked_items: items?.length ?? 0,
        matches: results,
        emails_sent: emailsSent,
        email_failures: emailFailures,
      }),
      {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json",
        },
      }
    );
  } finally {
    // #준희 추가: 성공·실패 여부와 관계없이 이 요청의 SMTP 연결만 정리
    transporter?.close();
  }
});
