// claim-mail: 시민이 보낸 수령 신청의 '신청 확인 메일'을 보냄  (#김다영 추가)
// - 화면은 방금 저장한 신청의 id만 보냄. 받는 주소는 DB에 저장된 신청의 이메일만 씀 (임의 주소로 보내는 통로가 되지 않게)
// - 한 신청당 한 번만 (mailed_at), 저장된 지 10분이 지난 신청에는 보내지 않음
// - 메일 방식은 match-alerts와 같음: Gmail SMTP(465). Secrets: GMAIL_USER, GMAIL_APP_PASSWORD
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
  const { data: c, error } = await db.from("claims")
    .select("id, contact, method, proxy_name, created_at, mailed_at, items(id, name, color, orgs(name, tel, hours))")
    .eq("id", id).maybeSingle();
  if (error || !c) return json({ sent: false, reason: "not_found" }, 404);
  if (c.mailed_at) return json({ sent: false, reason: "already_sent" });
  if (Date.now() - new Date(c.created_at).getTime() > 10 * 60_000) return json({ sent: false, reason: "too_old" });
  if (!c.contact || !EMAIL.test(c.contact)) return json({ sent: false, reason: "no_email" });

  const user = Deno.env.get("GMAIL_USER"), pass = Deno.env.get("GMAIL_APP_PASSWORD");
  if (!user || !pass) return json({ sent: false, reason: "mail_not_configured" }, 503);

  // 다른 요청이 먼저 보냈으면 건너뜀 (mailed_at이 비어 있을 때만 표시)
  const { data: lock } = await db.from("claims").update({ mailed_at: new Date().toISOString() }).eq("id", id).is("mailed_at", null).select("id");
  if (!lock?.length) return json({ sent: false, reason: "already_sent" });

  const it: any = c.items ?? {}, org: any = it.orgs ?? {};
  const text = [
    "유실물 e음에서 수령 신청을 받았어요.",
    "",
    `물품: ${it.name ?? "-"}${it.color ? ` (${it.color})` : ""}`,
    `관리번호: ${it.id ?? "-"}`,
    `보관 기관: ${org.name ?? "-"}${org.tel ? ` (${org.tel})` : ""}`,
    org.hours ? `운영 시간: ${org.hours}` : "",
    `받는 사람: ${c.method === "대리" ? `대리 수령 (${c.proxy_name ?? "-"})` : "본인 수령"}`,
    "",
    "담당자가 적어 주신 안쪽 특징을 주인 확인용 메모와 맞춰 본 뒤 연락드려요.",
    c.method === "대리"
      ? "대리인이 방문할 때 위임장과 분실자 신분증 사본을 꼭 챙겨 주세요."
      : "방문할 때 신분증을 챙겨 주세요.",
    "급하면 관리번호를 말하고 보관 기관에 바로 전화해도 돼요.",
    "",
    "적어 주신 연락처는 수령이 끝나거나 신청이 닫히면 바로 지워져요.",
    "본인이 신청하지 않았다면 이 메일은 무시해 주세요.",
  ].filter((l, i, a) => l !== "" || a[i - 1] !== "").join("\n");

  const t = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000 });
  try {
    await t.sendMail({ from: `유실물 e음 <${user}>`, to: c.contact, subject: `[유실물 e음] ${it.name ?? "습득물"} 수령 신청을 받았어요`, text });
    return json({ sent: true });
  } catch (e) {
    await db.from("claims").update({ mailed_at: null }).eq("id", id); // 실패하면 다시 보낼 수 있게 되돌림
    console.error("수령 신청 메일 실패:", String(e).replace(/[^\s<>"'@]+@[^\s<>"'@]+/g, "***@***").slice(0, 300));
    return json({ sent: false, reason: "smtp_failed" }, 502);
  } finally {
    t.close();
  }
});
