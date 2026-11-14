// alert-mail: 시민이 '비슷한 물건 알림'을 저장하면 '알림 저장 확인 메일'을 보냄  (#김다영 추가)
// - 화면은 방금 저장한 알림의 id만 보냄. 받는 주소는 DB에 저장된 알림의 이메일만 씀 (임의 주소로 보내는 통로가 되지 않게)
// - 한 알림당 한 번만 (saved_mailed_at), 저장된 지 10분이 지난 알림에는 보내지 않음
// - 메일 방식은 match-alerts·claim-mail과 같음: Gmail SMTP(465). Secrets: GMAIL_USER, GMAIL_APP_PASSWORD
// - 배포: JWT 검증 끄기 (시민은 로그인하지 않음)
import { createClient } from "npm:@supabase/supabase-js@2";
import nodemailer from "npm:nodemailer@6.9.16";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ sent: false, reason: "method_not_allowed" }, 405);
  let id = "";
  try { id = String((await req.json())?.id ?? ""); } catch { /* 아래에서 거절 */ }
  if (!UUID.test(id)) return json({ sent: false, reason: "bad_id" }, 400);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const { data: a, error } = await db.from("alerts")
    .select("id, label, email, email_consent, created_at, saved_mailed_at")
    .eq("id", id).maybeSingle();
  if (error || !a) return json({ sent: false, reason: "not_found" }, 404);
  if (a.saved_mailed_at) return json({ sent: false, reason: "already_sent" });
  if (Date.now() - new Date(a.created_at).getTime() > 10 * 60_000) return json({ sent: false, reason: "too_old" });
  if (!a.email || !a.email_consent || !EMAIL.test(a.email)) return json({ sent: false, reason: "no_email" });

  const user = Deno.env.get("GMAIL_USER"), pass = Deno.env.get("GMAIL_APP_PASSWORD");
  if (!user || !pass) return json({ sent: false, reason: "mail_not_configured" }, 503);

  // 다른 요청이 먼저 보냈으면 건너뜀 (saved_mailed_at이 비어 있을 때만 표시)
  const { data: lock } = await db.from("alerts").update({ saved_mailed_at: new Date().toISOString() }).eq("id", id).is("saved_mailed_at", null).select("id");
  if (!lock?.length) return json({ sent: false, reason: "already_sent" });

  const text = [
    "유실물 e음에 '비슷한 물건 알림'을 저장했어요.",
    "",
    `찾는 물건: ${a.label}`,
    "",
    "매일 오전 9시와 오후 6시에 새로 올라온 습득물과 비교해,",
    "닮음 점수 0.6 이상인 물건이 나오면 이 이메일로 알려 드려요.",
    "습득물은 등록까지 1~2일 걸릴 수 있어요.",
    "",
    "저장한 알림과 진행 상황은 유실물 e음 '내 알림 불러오기'에서 이 이메일로 확인할 수 있어요.",
    "본인이 저장하지 않았다면 이 메일은 무시해 주세요.",
  ].join("\n");

  const t = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000 });
  try {
    await t.sendMail({ from: `유실물 e음 <${user}>`, to: a.email, subject: "[유실물 e음] 비슷한 물건 알림을 저장했어요", text });
    return json({ sent: true });
  } catch (e) {
    await db.from("alerts").update({ saved_mailed_at: null }).eq("id", id); // 실패하면 다시 보낼 수 있게 되돌림
    console.error("알림 저장 메일 실패:", String(e).replace(/[^\s<>"'@]+@[^\s<>"'@]+/g, "***@***").slice(0, 300));
    return json({ sent: false, reason: "smtp_failed" }, 502);
  } finally {
    t.close();
  }
});
