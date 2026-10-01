/* ============================================================
   LINE webhook → เก็บข้อความกลุ่มลงตาราง line_inbox (แทน Make + Google Sheet)
   - POST จาก LINE: ตรวจลายเซ็น X-Line-Signature ด้วย LINE_CHANNEL_SECRET ก่อนทุกครั้ง
   - GET ?a=feed : หน้าเว็บอ่านข้อความล่าสุด (ต้องล็อกอิน — X-Session เดียวกับ sku-api)
   ============================================================ */
import postgres from "npm:postgres@3.4.4";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2 });
const KEEP_DAYS = 60;      // เก็บข้อความย้อนหลัง
const FEED_DAYS = 14;      // หน้าเว็บอ่านย้อนหลัง
const SESSION_DAYS = 30;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-session, authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};
const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

async function validSignature(raw: string, sig: string): Promise<boolean> {
  const secret = Deno.env.get("LINE_CHANNEL_SECRET") || "";
  if (!secret || !sig) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  const expected = btoa(String.fromCharCode(...mac));
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

const nameCache = new Map<string, string>();
async function senderName(groupId: string, userId: string): Promise<string> {
  const k = groupId + "|" + userId;
  if (nameCache.has(k)) return nameCache.get(k)!;
  const token = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") || "";
  let name = "";
  try {
    const r = await fetch(`https://api.line.me/v2/bot/group/${groupId}/member/${userId}`, { headers: { Authorization: "Bearer " + token } });
    if (r.ok) name = String((await r.json()).displayName || "");
  } catch (_) { /* ไม่ได้ชื่อก็ไม่เป็นไร */ }
  if (name) nameCache.set(k, name);
  return name;
}

/* รูป: ดึงจาก LINE เก็บใน Storage ทันทีที่ส่งเข้ากลุ่ม (ทำเบื้องหลังหลังตอบ LINE แล้ว) — ชื่อไฟล์แบบเดียวกับ sku-api line_image */
const IMG_BUCKET = "line-images";
async function storeImage(id: string) {
  try {
    const found = await sql`select name from storage.objects where bucket_id = ${IMG_BUCKET} and name like ${id + "-%"} limit 1`;
    let name = found[0]?.name as string | undefined;
    if (!name) {
      const r = await fetch(`https://api-data.line.me/v2/bot/message/${id}/content`, { headers: { Authorization: "Bearer " + (Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") || "") } });
      if (!r.ok) return;
      const type = (r.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
      const ext = ({ "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" } as Record<string, string>)[type];
      if (!ext) return;
      const rnd = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
      name = `${id}-${rnd}.${ext}`;
      const k = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
      const up = await fetch(`${Deno.env.get("SUPABASE_URL")}/storage/v1/object/${IMG_BUCKET}/${name}`, {
        method: "POST", headers: { Authorization: "Bearer " + k, apikey: k, "Content-Type": type }, body: new Uint8Array(await r.arrayBuffer()),
      });
      if (!up.ok) { console.error("storage upload failed", up.status, await up.text()); return; }
    }
    await sql`update line_inbox set url = ${`${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/${IMG_BUCKET}/${name}`} where msg_id = ${id}`;
  } catch (e) { console.error("storeImage", e); }
}

// ข้อความแจ้งงานเสร็จ (ไม่ได้แท็กบอท) — แทนการจัดประเภทด้วย AI เดิม
const DONE_RE = /(เสร็จแล้ว|ทำแล้ว|ส่งแล้ว|เรียบร้อยแล้ว|เรียบร้อย|done)/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  try {
    if (req.method === "GET" && url.searchParams.get("a") === "feed") {
      const token = req.headers.get("x-session") || "";
      if (!/^[0-9a-f]{64}$/.test(token)) return respond({ ok: false, error: "unauthorized" }, 401);
      const s = await sql`select 1 from sessions where token = ${token} and created_at > now() - make_interval(days => ${SESSION_DAYS}) limit 1`;
      if (!s.length) return respond({ ok: false, error: "unauthorized" }, 401);
      const since = Date.now() - FEED_DAYS * 86400000;
      const rows = await sql`select msg_id, ts, type, message, sender, group_id, user_id, quote_token, quoted_id, url
                             from line_inbox where ts >= ${since} order by ts limit 3000`;
      return respond({ ok: true, rows });
    }

    if (req.method !== "POST") return respond({ ok: true });
    const raw = await req.text();
    if (!(await validSignature(raw, req.headers.get("x-line-signature") || ""))) return respond({ ok: false }, 401);
    let body: { events?: Record<string, any>[] } = {};
    try { body = JSON.parse(raw); } catch { return respond({ ok: false }, 400); }
    if (!(body.events || []).length) return respond({ ok: true }); // ปุ่ม Verify ของ LINE ส่ง events ว่าง
    const tag = "@sofia alvarez";
    const bg: Promise<void>[] = [];
    for (const ev of body.events || []) {
      if (ev.type !== "message" || ev.source?.type !== "group") continue;
      const m = ev.message || {};
      if (m.type !== "text" && m.type !== "image") continue;
      const groupId = String(ev.source.groupId || ""), userId = String(ev.source.userId || "");
      const text = m.type === "text" ? String(m.text || "") : String(m.id || "");
      const type = m.type === "image" ? "IMAGE" : (!text.toLowerCase().includes(tag) && !m.quotedMessageId && DONE_RE.test(text) ? "DONE" : "TEXT");
      await sql`insert into line_inbox (msg_id, ts, type, message, sender, group_id, user_id, quote_token, quoted_id)
                values (${String(m.id)}, ${Number(ev.timestamp) || Date.now()}, ${type}, ${text}, ${await senderName(groupId, userId)},
                        ${groupId}, ${userId}, ${String(m.quoteToken || "")}, ${String(m.quotedMessageId || "")})
                on conflict (msg_id) do nothing`;
      if (type === "IMAGE") bg.push(storeImage(String(m.id)));
    }
    // ตอบ LINE ทันที แล้วค่อยเก็บรูปเบื้องหลัง
    // deno-lint-ignore no-explicit-any
    const rt = (globalThis as any).EdgeRuntime;
    if (bg.length) { const all = Promise.all(bg).then(() => {}); if (rt?.waitUntil) rt.waitUntil(all); else await all; }
    if (Math.random() < 0.05) await sql`delete from line_inbox where ts < ${Date.now() - KEEP_DAYS * 86400000}`; // ล้างของเก่าเป็นครั้งคราว
    return respond({ ok: true });
  } catch (e) {
    console.error(e);
    return respond({ ok: false }, 500);
  }
});
