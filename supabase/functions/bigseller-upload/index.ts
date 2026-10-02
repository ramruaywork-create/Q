/* ============================================================
   รับไฟล์ส่งออกจาก BigSeller (ส่วนขยาย "ชิวเกิน") → เก็บใน Storage bucket bigseller-exports (ส่วนตัว)
   - POST ?name=<ไฟล์> : body = ไฟล์ .xlsx (ส่วนขยายล็อกอินด้วยบัญชี TaskCheck แล้วส่ง X-Session มา)
   - GET  ?a=list      : หน้าเว็บ TaskCheck ขอรายการไฟล์ล่าสุด + ลิงก์ดาวน์โหลดชั่วคราว
   ทั้งสองแบบต้องมี X-Session ที่ยังไม่หมดอายุ (ตาราง sessions เดียวกับ sku-api)
   ============================================================ */
import postgres from "npm:postgres@3.4.4";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 2 });
const BUCKET = "bigseller-exports";
const KEEP_DAYS = 14;      // ลบไฟล์เก่ากว่านี้
const LIST_HOURS = 36;     // หน้าเว็บดึงไฟล์ย้อนหลัง
const SESSION_DAYS = 30;
const MAX_BYTES = 50 * 1024 * 1024;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-session, authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};
const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

const SUPA = Deno.env.get("SUPABASE_URL")!;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const storage = (path: string, init: RequestInit = {}) =>
  fetch(`${SUPA}/storage/v1/${path}`, { ...init, headers: { Authorization: "Bearer " + KEY, apikey: KEY, ...(init.headers || {}) } });

async function validSession(token: string) {
  if (!/^[0-9a-f]{64}$/.test(token)) return false;
  const s = await sql`select 1 from sessions where token = ${token} and created_at > now() - make_interval(days => ${SESSION_DAYS}) limit 1`;
  return s.length > 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  try {
    if (req.method !== "GET" && req.method !== "POST") return respond({ ok: false }, 405);
    if (!(await validSession(req.headers.get("x-session") || ""))) return respond({ ok: false, error: "unauthorized" }, 401);
    if (req.method === "GET") {
      const rows = await sql`select name, created_at, (metadata->>'size')::bigint as size from storage.objects
                             where bucket_id = ${BUCKET} and created_at > now() - make_interval(hours => ${LIST_HOURS})
                             order by created_at desc limit 50`;
      const files = [];
      for (const r of rows) {
        const sg = await storage(`object/sign/${BUCKET}/${r.name}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expiresIn: 600 }) });
        if (!sg.ok) continue;
        const j = await sg.json();
        files.push({ name: r.name, at: r.created_at, size: Number(r.size) || 0, url: SUPA + "/storage/v1" + j.signedURL });
      }
      return respond({ ok: true, files });
    }

    const body = new Uint8Array(await req.arrayBuffer());
    if (!body.length || body.length > MAX_BYTES) return respond({ ok: false, error: "ขนาดไฟล์ไม่ถูกต้อง" }, 400);
    // .xlsx และ .zip (SKU Merchant ส่งออกเป็น zip) ขึ้นต้นด้วย PK ทั้งคู่
    if (body[0] !== 0x50 || body[1] !== 0x4b) return respond({ ok: false, error: "ไม่ใช่ไฟล์ .xlsx / .zip" }, 400);
    const base = (url.searchParams.get("name") || "export.xlsx").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);
    const isZip = /\.zip$/i.test(base);
    const day = new Date(Date.now() + 7 * 3600000).toISOString().slice(0, 10); // วันที่เวลาไทย
    const name = `${day}/${Date.now()}-${isZip || base.endsWith(".xlsx") ? base : base + ".xlsx"}`;
    const up = await storage(`object/${BUCKET}/${name}`, {
      method: "POST",
      headers: { "Content-Type": isZip ? "application/zip" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      body,
    });
    if (!up.ok) { console.error("upload failed", up.status, await up.text()); return respond({ ok: false, error: "เก็บไฟล์ไม่สำเร็จ" }, 500); }
    // ล้างไฟล์เก่าเป็นครั้งคราว
    if (Math.random() < 0.2) {
      const old = await sql`select name from storage.objects where bucket_id = ${BUCKET} and created_at < now() - make_interval(days => ${KEEP_DAYS}) limit 200`;
      if (old.length) await storage(`object/${BUCKET}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: old.map((o) => o.name) }) });
    }
    return respond({ ok: true, name, size: body.length });
  } catch (e) {
    console.error(e);
    return respond({ ok: false, error: "server error" }, 500);
  }
});
