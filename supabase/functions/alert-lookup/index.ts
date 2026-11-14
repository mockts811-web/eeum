// alert-lookup: 이메일로 '비슷한 물건 알림'을 다시 불러오기  (#김다영 추가)
// 1) { action: "send", email }        → 그 이메일로 6자리 확인 코드 메일 (10분 유효, 1분에 한 번, 1시간에 5번까지)
// 2) { action: "verify", email, code } → 코드가 맞으면 그 이메일로 저장된 알림과 실제 진행 상황(비교 시각·후보 물건·상태)을 돌려줌
// - 이메일만으로는 아무것도 보여 주지 않음 (남의 알림을 볼 수 없게)
// - 코드는 해시로만 저장, 5번 틀리면 무효, 확인되면 바로 지움
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
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const likeEsc = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c); // ilike에서 글자 그대로 비교

async function hash(email: string, code: string): Promise<string> {
  const pepper = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${email}|${code}|${pepper}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ ok: false, reason: "method_not_allowed" }, 405);
  let body: any = {};
  try { body = await req.json(); } catch { /* 아래에서 거절 */ }
  const email = String(body?.email ?? "").trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 120) return json({ ok: false, reason: "bad_email" }, 400);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

  if (body.action === "send") {
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const { data: recent } = await db.from("alert_codes").select("created_at").eq("email", email).gte("created_at", hourAgo).order("created_at", { ascending: false });
    if (recent?.length && Date.now() - new Date(recent[0].created_at).getTime() < 60_000) return json({ ok: false, reason: "wait" }, 429);
    if ((recent?.length ?? 0) >= 5) return json({ ok: false, reason: "too_many" }, 429);

    const { count } = await db.from("alerts").select("id", { count: "exact", head: true }).ilike("email", likeEsc(email));
    const user = Deno.env.get("GMAIL_USER"), pass = Deno.env.get("GMAIL_APP_PASSWORD");
    if (!user || !pass) return json({ ok: false, reason: "mail_not_configured" }, 503);

    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
    await db.from("alert_codes").delete().eq("email", email); // 예전 코드는 무효
    await db.from("alert_codes").insert({ email, code_hash: await hash(email, code), expires_at: new Date(Date.now() + 10 * 60_000).toISOString() });

    // 저장된 알림이 없어도 메일은 보냄 (있는지 없는지를 화면 응답으로 알 수 없게)
    const text = count
      ? `유실물 e음 '비슷한 물건 알림' 확인 코드예요.\n\n확인 코드: ${code}\n\n10분 안에 화면에 입력하면 이 이메일로 저장한 알림 ${count}건과 진행 상황을 볼 수 있어요.\n본인이 요청하지 않았다면 이 메일은 무시해 주세요.`
      : `유실물 e음에서 '내 알림 불러오기'를 요청했지만, 이 이메일로 저장된 알림이 없어요.\n\n알림을 저장할 때 이메일을 남기고 동의에 체크했는지 확인해 주세요.\n본인이 요청하지 않았다면 이 메일은 무시해 주세요.`;
    const t = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user, pass }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000 });
    try {
      await t.sendMail({ from: `유실물 e음 <${user}>`, to: email, subject: count ? `[유실물 e음] 알림 확인 코드 ${code}` : "[유실물 e음] 저장된 알림이 없어요", text });
      return json({ ok: true });
    } catch (e) {
      console.error("확인 코드 메일 실패:", String(e).replace(/[^\s<>"'@]+@[^\s<>"'@]+/g, "***@***").slice(0, 300));
      return json({ ok: false, reason: "smtp_failed" }, 502);
    } finally { t.close(); }
  }

  if (body.action === "verify") {
    const code = String(body?.code ?? "").replace(/\D/g, "");
    if (code.length !== 6) return json({ ok: false, reason: "bad_code" }, 400);
    const { data: row } = await db.from("alert_codes").select("id, code_hash, attempts, expires_at").eq("email", email).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!row || new Date(row.expires_at).getTime() < Date.now()) return json({ ok: false, reason: "expired" }, 400);
    if (row.attempts >= 5) return json({ ok: false, reason: "too_many_attempts" }, 429);
    if (row.code_hash !== await hash(email, code)) {
      await db.from("alert_codes").update({ attempts: row.attempts + 1 }).eq("id", row.id);
      return json({ ok: false, reason: "wrong_code", left: Math.max(0, 4 - row.attempts) }, 400);
    }
    await db.from("alert_codes").delete().eq("email", email); // 한 번 쓰면 끝

    const { data: alerts } = await db.from("alerts").select("id, label, created_at, last_checked_at").ilike("email", likeEsc(email)).order("created_at", { ascending: false }).limit(50);
    const ids = (alerts ?? []).map((a) => a.id);
    const { data: hits } = ids.length
      ? await db.from("alert_hits").select("alert_id, item_id, score, items(id, name, color, status, kind, found_on, found_place, orgs(name, tel))").in("alert_id", ids)
      : { data: [] as any[] };
    const byAlert: Record<string, any[]> = {};
    (hits ?? []).forEach((h: any) => {
      const it = h.items ?? {};
      (byAlert[h.alert_id] ??= []).push({ item_id: h.item_id, score: Number(h.score), name: it.name ?? "", color: it.color ?? "", status: it.status ?? "", kind: it.kind ?? "", found_on: it.found_on ?? "", found_place: it.found_place ?? "", org: it.orgs?.name ?? "", tel: it.orgs?.tel ?? "" });
    });
    return json({
      ok: true,
      alerts: (alerts ?? []).map((a) => ({ ...a, hits: (byAlert[a.id] ?? []).sort((x, y) => y.score - x.score) })),
    });
  }

  return json({ ok: false, reason: "bad_action" }, 400);
});
