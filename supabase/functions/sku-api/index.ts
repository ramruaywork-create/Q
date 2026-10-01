/* ============================================================
   SKU Work Tracker — Supabase Edge Function (แทน api.php สำหรับเว็บบน GitHub Pages)
   actions เหมือน api.php: me, login, logout, bootstrap, sync, change_password + import_local
   - ข้อมูลทั้งหมดอยู่ในแถวเดียว app_state.db (jsonb) ล็อกแถวทุกครั้งที่เขียน → หลายคนบันทึกพร้อมกันได้
   - login ด้วย session token (ส่งมาใน header X-Session) เพราะเว็บกับ API อยู่คนละโดเมน
   - รหัสผ่านเก็บเป็น bcrypt ฝั่ง server เท่านั้น
   ============================================================ */
import postgres from "npm:postgres@3.4.4";
import bcrypt from "npm:bcryptjs@2.4.3";
import PRODUCTS from "./products.ts";

// deno-lint-ignore no-explicit-any
type Obj = Record<string, any>;

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 3 });

const COLLECTIONS = ["users", "shops", "products", "worklogs", "tiktoks", "history", "tiktok_jobs", "sales", "import_audits", "tasks", "campaigns", "albums"];
const LIMITS: Record<string, number> = { history: 3000, import_audits: 1000 };
const SESSION_DAYS = 30;
const DEFAULT_SHOPS = [
  ["Shopee", "DP"], ["Shopee", "KS"], ["Shopee", "ALP"], ["Shopee", "BS"], ["Shopee", "AM"], ["Shopee", "PK"], ["Shopee", "PS"], ["Shopee", "A2"],
  ["Lazada", "PR"], ["Lazada", "ZN"], ["Lazada", "PT"], ["Lazada", "WS"], ["Lazada", "TP"], ["Lazada", "PP"],
  ["TikTok", "SP"], ["TikTok", "TJ"], ["TikTok", "PROSPERSPORT"], ["TikTok", "PM"],
];

const CORS = {
  "Access-Control-Allow-Origin": "*", // ไม่ใช้ cookie — ยืนยันตัวตนด้วย token เท่านั้น
  "Access-Control-Allow-Headers": "content-type, x-session, authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};
const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

const nowIso = () => new Date().toISOString();
const newId = () => Date.now().toString(36) + crypto.getRandomValues(new Uint8Array(3)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
const randomToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");

/* รหัสผ่านจากโหมดเครื่องเดียวเป็น hash แบบเก่า ('h' + djb2) — รับได้ตอน login แล้วอัปเกรดเป็น bcrypt */
function legacyHash(s: string) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return "h" + h.toString(16); }
const isBcrypt = (stored: string) => /^\$2[aby]\$/.test(stored || "");
const verifyPass = (pw: string, stored: string) => isBcrypt(stored) ? bcrypt.compareSync(pw, stored) : !!stored && stored === legacyHash(pw);
const hashPass = (pw: string) => bcrypt.hashSync(pw, 10);

function seedDb(): Obj {
  const shops = DEFAULT_SHOPS.map(([platform, code], i) => ({ id: "s" + (i + 1), platform, code, name: code, active: true }));
  const now = nowIso();
  const adminPass = hashPass("admin123"), userPass = hashPass("user123");
  const users = [
    { id: "u1", name: "Admin", username: "admin", pass: adminPass, role: "Admin", active: true, shop_ids: shops.map((s) => s.id), created_at: now },
    { id: "u2", name: "A", username: "userA", pass: userPass, role: "User", active: true, shop_ids: ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"], created_at: now },
    { id: "u3", name: "B", username: "userB", pass: userPass, role: "User", active: true, shop_ids: ["s9", "s10", "s11", "s12", "s13", "s14", "s15", "s16"], created_at: now },
    { id: "u4", name: "C", username: "userC", pass: userPass, role: "User", active: true, shop_ids: ["s17", "s18", "s1", "s9", "s15"], created_at: now },
  ];
  const products = PRODUCTS.map(([sku, brand, name], i) => ({ id: "p" + (i + 1), sku, name, brand, created_at: now, active: true }));
  return { users, shops, products, worklogs: [], tiktoks: [], history: [], tiktok_jobs: [], sales: [], import_audits: [], tasks: [], campaigns: [], albums: [], meta: {} };
}

function normalizeUserShopIds(db: Obj) {
  const all = db.shops.filter((s: Obj) => s.id).map((s: Obj) => s.id);
  for (const u of db.users) {
    if (!Array.isArray(u.shop_ids)) u.shop_ids = [];
    u.shop_ids = (u.role ?? "User") === "Admin" ? all : [...new Set(u.shop_ids.filter((id: string) => all.includes(id)))];
  }
}
function migrateDb(db: Obj) {
  for (const c of COLLECTIONS) if (!Array.isArray(db[c])) db[c] = [];
  if (!db.meta || typeof db.meta !== "object" || Array.isArray(db.meta)) db.meta = {};
  for (const s of db.sales) if (!s.id) s.id = newId();
  for (const h of db.history) if (!h.id) h.id = newId();
  normalizeUserShopIds(db);
}
const stripUser = (u: Obj) => { const { pass: _p, new_password: _n, ...rest } = u; return rest; };
const publicDb = (db: Obj) => ({ ...db, users: db.users.map(stripUser) });

/* อ่าน/เขียน db แบบล็อกแถว (write=true) */
async function withDb<T>(fn: (db: Obj) => T | Promise<T>, write = false): Promise<T> {
  const res = await sql.begin(async (tx) => {
    const rows = write ? await tx`select db from app_state where id = 1 for update` : await tx`select db from app_state where id = 1`;
    let db = rows[0]?.db as Obj | null;
    if (!db || typeof db !== "object") {
      if (!write) return { retry: true as const };
      db = seedDb();
    }
    migrateDb(db);
    const result = await fn(db);
    if (write) await tx`update app_state set db = ${tx.json(db)}, updated_at = now() where id = 1`;
    return { result };
  });
  if ("retry" in res) return withDb(fn, true); // ยังไม่มีข้อมูล → seed ด้วยล็อก
  return res.result as T;
}

async function sessionUserId(req: Request): Promise<string | null> {
  const token = req.headers.get("x-session") || "";
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const rows = await sql`update sessions set last_seen = now() where token = ${token} and created_at > now() - make_interval(days => ${SESSION_DAYS}) returning user_id`;
  return rows[0]?.user_id ?? null;
}
const activeUser = (db: Obj, id: string | null) => (id ? db.users.find((u: Obj) => u.id === id && u.active) : null) || null;
/* รูปจาก LINE เก็บใน Storage (public bucket) — ลบอัตโนมัติเมื่อเก่ากว่า 60 วัน ยกเว้นรูปในคลังรูป (อัลบั้ม) รูปของงานที่ยังไม่เสร็จ หรือเพิ่งเสร็จไม่ถึง 60 วัน */
const IMG_BUCKET = "line-images";
const IMG_KEEP_DAYS = 60;
const imgUrl = (name: string) => `${Deno.env.get("SUPABASE_URL")}/storage/v1/object/public/${IMG_BUCKET}/${name}`;
const storageAuth = () => { const k = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""; return { Authorization: "Bearer " + k, apikey: k }; };
async function cleanupImages(): Promise<number> {
  const cutoff = Date.now() - IMG_KEEP_DAYS * 86400000;
  const keep = await withDb((db) => {
    const s = new Set<string>();
    for (const t of db.tasks) for (const img of (Array.isArray(t.images) ? t.images : []))
      if (t.status !== "done" || !t.done_at || Date.parse(t.done_at) > cutoff) s.add(String(img.id));
    for (const a of db.albums) for (const img of (Array.isArray(a.images) ? a.images : [])) s.add(String(img.id));
    return s;
  });
  const old = await sql`select name from storage.objects where bucket_id = ${IMG_BUCKET} and created_at < now() - make_interval(days => ${IMG_KEEP_DAYS})`;
  const del = old.map((o) => String(o.name)).filter((n) => !keep.has(n.split("-")[0]));
  if (!del.length) return 0;
  const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/storage/v1/object/${IMG_BUCKET}`, {
    method: "DELETE", headers: { ...storageAuth(), "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: del }),
  });
  if (!r.ok) throw new Error("storage delete " + r.status + " " + await r.text());
  return del.length;
}
async function readJson(req: Request): Promise<Obj> { try { const j = await req.json(); return j && typeof j === "object" ? j : {}; } catch { return {}; } }

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const action = new URL(req.url).searchParams.get("a") || "";
  try {
    if (action === "health") return respond({ ok: true, api: true });

    if (action === "me") {
      const uid = await sessionUserId(req);
      const out = await withDb((db) => ({
        user: activeUser(db, uid) ? stripUser(activeUser(db, uid)) : null,
        default_admin: db.users.some((u: Obj) => u.role === "Admin" && u.active && verifyPass("admin123", u.pass || "")),
      }));
      return respond({ api: true, ...out });
    }

    if (action === "login") {
      if (req.method !== "POST") return respond({ ok: false }, 405);
      const inp = await readJson(req);
      const username = String(inp.username ?? "").trim(), password = String(inp.password ?? "");
      const user = await withDb((db) => {
        const u = db.users.find((x: Obj) => x.active && String(x.username).toLowerCase() === username.toLowerCase());
        if (!u || !verifyPass(password, u.pass || "")) return null;
        if (!isBcrypt(u.pass)) u.pass = hashPass(password); // อัปเกรดรหัสแบบเก่า
        return stripUser(u);
      }, true);
      if (!user) { await new Promise((r) => setTimeout(r, 400)); return respond({ ok: false }); }
      const token = randomToken();
      await sql`insert into sessions (token, user_id) values (${token}, ${user.id})`;
      await sql`delete from sessions where created_at < now() - make_interval(days => ${SESSION_DAYS})`;
      return respond({ ok: true, user, token });
    }

    if (action === "logout") {
      const token = req.headers.get("x-session") || "";
      if (token) await sql`delete from sessions where token = ${token}`;
      return respond({ ok: true });
    }

    /* ตัวตั้งเวลา (pg_cron 09:00 น.) เรียกทุกเช้า: แคมเปญวิดีโอที่กด "ทำแล้ว" และถึงเวลาแจ้ง → บอท Reply ข้อความ /VDO/ ว่า "เช็คหน่อย" */
    if (action === "cron_notify") {
      const key = req.headers.get("x-cron-key") || "";
      const rows = await sql`select value from cron_config where key = 'cron'`;
      if (!key || !rows[0] || key !== rows[0].value) return respond({ ok: false }, 401);
      const lineToken = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") || "";
      if (!lineToken) return respond({ ok: false, error: "no LINE token" });
      const now = nowIso();
      const due = await withDb((db) => {
        const list: Obj[] = [];
        for (const c of db.campaigns) {
          if (c.kind !== "target" || !c.done_at || !c.notify_at || c.notified_at || c.notify_at > now || !c.line_group || !c.line_user) continue;
          c.notified_at = now; c.updated_at = now; // จองก่อนส่ง กันส่งซ้ำ
          const shop = db.shops.find((s: Obj) => s.id === c.shop_id) || {};
          list.push({ id: c.id, group: c.line_group, user: c.line_user, quote: c.line_quote || "", text: `{requester} ${shop.platform || ""} ${shop.code || ""} ลงวิดีโอครบ ${c.target} ตัวแล้ว เช็คหน่อย` });
        }
        return list;
      }, true);
      let sent = 0;
      for (const d of due) {
        const r = await fetch("https://api.line.me/v2/bot/message/push", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + lineToken },
          body: JSON.stringify({ to: d.group, messages: [{ type: "textV2", text: d.text,
            substitution: { requester: { type: "mention", mentionee: { type: "user", userId: d.user } } },
            ...(d.quote ? { quoteToken: d.quote } : {}) }] }),
        });
        if (r.ok) { sent++; continue; }
        console.error("LINE push failed", r.status, await r.text());
        await withDb((db) => { const c = db.campaigns.find((x: Obj) => x.id === d.id); if (c) { delete c.notified_at; c.updated_at = nowIso(); } }, true);
      }
      const cleaned = await cleanupImages().catch((e) => { console.error("image cleanup", e); return -1; });
      return respond({ ok: true, due: due.length, sent, cleaned });
    }

    const uid = await sessionUserId(req);
    if (!uid) return respond({ ok: false, error: "unauthorized" }, 401);

    if (action === "bootstrap") {
      const out = await withDb((db) => { const me = activeUser(db, uid); return me ? { user: stripUser(me), db: publicDb(db) } : null; });
      if (!out) return respond({ ok: false, error: "unauthorized" }, 401);
      return respond({ ok: true, ...out });
    }

    /* รวมการเปลี่ยนแปลง (upsert / delete ต่อ collection) เข้ากับที่คนอื่นบันทึกไว้ */
    if (action === "sync") {
      if (req.method !== "POST") return respond({ ok: false }, 405);
      const inp = await readJson(req);
      const ops: Obj = inp.ops && typeof inp.ops === "object" ? inp.ops : {};
      const meta: Obj | null = inp.meta && typeof inp.meta === "object" && !Array.isArray(inp.meta) ? inp.meta : null;
      const res = await withDb((db) => {
        const me = activeUser(db, uid);
        if (!me) return { error: "unauthorized" };
        const isAdmin = me.role === "Admin";
        const skipped: string[] = [];
        for (const [coll, op] of Object.entries(ops)) {
          if (!COLLECTIONS.includes(coll) || !op || typeof op !== "object") continue;
          if ((coll === "users" || coll === "shops") && !isAdmin) { skipped.push(coll); continue; }
          const list: Obj[] = db[coll];
          for (const id of Array.isArray(op.delete) ? op.delete : []) {
            if (coll === "users" && id === me.id) continue; // ห้ามลบตัวเอง
            const i = list.findIndex((x) => x.id === id); if (i >= 0) list.splice(i, 1);
          }
          upserts: for (const raw of Array.isArray(op.upsert) ? op.upsert : []) {
            if (!raw || typeof raw !== "object" || typeof raw.id !== "string" || !raw.id) continue;
            const item: Obj = { ...raw };
            let i = list.findIndex((x) => x.id === item.id);
            if (coll === "users") {
              const newPw = typeof item.new_password === "string" ? item.new_password : "";
              delete item.pass; delete item.new_password;
              if (i >= 0) item.pass = list[i].pass;
              else if (!newPw) continue; // ผู้ใช้ใหม่ต้องมีรหัสผ่าน
              if (newPw) item.pass = hashPass(newPw);
              if (item.id === me.id) { item.role = "Admin"; item.active = true; } // กันแอดมินลดสิทธิ์ตัวเอง
              for (let j = 0; j < list.length; j++) { // username ห้ามซ้ำ
                if (j !== i && String(list[j].username ?? "").toLowerCase() === String(item.username ?? "").toLowerCase()) continue upserts;
              }
            }
            if (coll === "worklogs") { // SKU + Platform + ร้าน มีได้ 1 รายการ — เก็บอันล่าสุด
              for (let j = 0; j < list.length; j++) {
                const w = list[j];
                if (j !== i && (w.product_id ?? "") === (item.product_id ?? "") && (w.platform ?? "") === (item.platform ?? "") && (w.shop_id ?? "") === (item.shop_id ?? "")) {
                  if (String(w.updated_at ?? "") > String(item.updated_at ?? "")) continue upserts;
                  list.splice(j, 1); if (i > j) i--; break;
                }
              }
            }
            // งาน: ถ้าในเซิร์ฟเวอร์ใหม่กว่า (เช่น Admin มอบหมายไปแล้ว) ไม่ให้สำเนาเก่าจากอีกเครื่องทับ
            if ((coll === "tasks" || coll === "campaigns" || coll === "albums") && i >= 0 && String(list[i].updated_at ?? "") > String(item.updated_at ?? "")) continue;
            if (i >= 0) list[i] = item; else list.push(item);
          }
          const lim = LIMITS[coll];
          if (lim && list.length > lim) db[coll] = coll === "history" ? list.slice(0, lim) : list.slice(-lim);
        }
        if (meta) db.meta = { ...db.meta, ...meta };
        normalizeUserShopIds(db);
        return { ok: true, skipped };
      }, true);
      if ("error" in res) return respond({ ok: false, error: res.error }, 401);
      return respond(res);
    }

    if (action === "change_password") {
      if (req.method !== "POST") return respond({ ok: false }, 405);
      const inp = await readJson(req);
      const oldPw = String(inp.old ?? ""), newPw = String(inp.new ?? "");
      if (newPw.length < 4) return respond({ ok: false, error: "รหัสใหม่ต้องอย่างน้อย 4 ตัวอักษร" });
      const r = await withDb((db) => {
        const u = db.users.find((x: Obj) => x.id === uid);
        if (!u) return "ไม่พบผู้ใช้";
        if (!verifyPass(oldPw, u.pass || "")) return "รหัสเก่าไม่ถูกต้อง";
        u.pass = hashPass(newPw); return true;
      }, true);
      return respond(r === true ? { ok: true } : { ok: false, error: r });
    }

    /* งานจาก LINE เสร็จแล้ว → บอทส่งข้อความเข้ากลุ่มเดิม แท็กคนสั่งงาน ("@W ทำแล้ว — ชื่องาน")
       ต้องตั้ง secret LINE_CHANNEL_ACCESS_TOKEN (Channel access token ของบอท) ใน Supabase */
    if (action === "line_done") {
      if (req.method !== "POST") return respond({ ok: false }, 405);
      const lineToken = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") || "";
      if (!lineToken) return respond({ ok: false, error: "ยังไม่ได้ตั้งค่า LINE token ใน Supabase" });
      const id = String((await readJson(req)).id ?? "");
      const claim = await withDb((db) => { // จองก่อนส่ง กันส่งซ้ำเมื่อหลายเครื่องกดพร้อมกัน
        if (!activeUser(db, uid)) return null;
        const t = db.tasks.find((x: Obj) => x.id === id);
        if (!t || t.status !== "done" || !t.line_group || !t.line_user || t.line_done_at) return null;
        t.line_done_at = nowIso(); t.updated_at = nowIso();
        return { group: t.line_group as string, user: t.line_user as string, title: String(t.title || ""), quote: String(t.line_quote || "") };
      }, true);
      if (!claim) return respond({ ok: true, sent: false });
      const r = await fetch("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + lineToken },
        body: JSON.stringify({ to: claim.group, messages: [{
          type: "textV2", text: "{requester} ทำแล้ว" + (claim.title ? " — " + claim.title.slice(0, 200) : ""),
          substitution: { requester: { type: "mention", mentionee: { type: "user", userId: claim.user } } },
          ...(claim.quote ? { quoteToken: claim.quote } : {}), // มี quoteToken จากชีต → ขึ้นเป็น Reply ข้อความเดิม
        }] }),
      });
      if (!r.ok) {
        console.error("LINE push failed", r.status, await r.text());
        await withDb((db) => { const t = db.tasks.find((x: Obj) => x.id === id); if (t) { delete t.line_done_at; t.updated_at = nowIso(); } }, true);
        return respond({ ok: false, error: "ส่งข้อความ LINE ไม่สำเร็จ (" + r.status + ")" });
      }
      return respond({ ok: true, sent: true });
    }

    /* รูปจากกลุ่ม LINE (ชีตมีแค่ message id) → ดึงรูปจาก LINE มาเก็บใน Storage bucket line-images แล้วคืนลิงก์
       ชื่อไฟล์มีเลขสุ่มต่อท้าย เดาลิงก์จาก message id ไม่ได้ */
    if (action === "line_image") {
      if (req.method !== "POST") return respond({ ok: false }, 405);
      const id = String((await readJson(req)).id ?? "");
      if (!/^\d{5,25}$/.test(id)) return respond({ ok: false, error: "bad id" });
      const me = await withDb((db) => activeUser(db, uid));
      if (!me) return respond({ ok: false, error: "unauthorized" }, 401);
      const found = await sql`select name from storage.objects where bucket_id = ${IMG_BUCKET} and name like ${id + "-%"} limit 1`;
      if (found[0]) return respond({ ok: true, url: imgUrl(found[0].name) });
      const lineToken = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") || "";
      if (!lineToken) return respond({ ok: false, error: "no LINE token" });
      const r = await fetch(`https://api-data.line.me/v2/bot/message/${id}/content`, { headers: { Authorization: "Bearer " + lineToken } });
      if (r.status === 202) return respond({ ok: false, pending: true }); // LINE ยังเตรียมไฟล์ไม่เสร็จ
      if (!r.ok) return respond({ ok: false, gone: r.status === 404 || r.status === 410, error: "LINE " + r.status });
      const type = (r.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
      const ext = ({ "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" } as Record<string, string>)[type];
      if (!ext) return respond({ ok: false, gone: true, error: "not image" });
      const name = `${id}-${randomToken().slice(0, 16)}.${ext}`;
      const up = await fetch(`${Deno.env.get("SUPABASE_URL")}/storage/v1/object/${IMG_BUCKET}/${name}`, {
        method: "POST", headers: { ...storageAuth(), "Content-Type": type }, body: new Uint8Array(await r.arrayBuffer()),
      });
      if (!up.ok) { console.error("storage upload failed", up.status, await up.text()); return respond({ ok: false, error: "upload " + up.status }); }
      return respond({ ok: true, url: imgUrl(name) });
    }

    /* ย้ายข้อมูลจากโหมดเครื่องเดียว (localStorage ของ Admin) ขึ้นเซิร์ฟเวอร์ — ทำได้ครั้งเดียว */
    if (action === "import_local") {
      if (req.method !== "POST") return respond({ ok: false }, 405);
      const inp = await readJson(req);
      const src: Obj = inp.db && typeof inp.db === "object" ? inp.db : {};
      const r = await withDb((db) => {
        const me = activeUser(db, uid);
        if (!me || me.role !== "Admin") return "เฉพาะ Admin";
        if (db.meta.local_imported) return "ย้ายข้อมูลไปแล้ว";
        for (const c of COLLECTIONS) {
          if (!Array.isArray(src[c])) continue;
          if (c === "users") {
            const users = src.users.filter((u: Obj) => u && typeof u.id === "string" && u.username).map((u: Obj) => {
              const cur = db.users.find((x: Obj) => x.id === u.id);
              const { new_password: _n, ...rest } = u;
              return { ...rest, pass: typeof u.pass === "string" && u.pass ? u.pass : cur?.pass };
            }).filter((u: Obj) => u.pass);
            if (!users.some((u: Obj) => u.id === me.id)) users.unshift(me); // คนที่ย้ายต้องยังเข้าได้
            for (const u of users) if (u.id === me.id) { u.role = "Admin"; u.active = true; }
            db.users = users;
          } else db[c] = src[c].filter((x: Obj) => x && typeof x === "object");
        }
        db.meta = { ...(src.meta && typeof src.meta === "object" ? src.meta : {}), local_imported: nowIso() };
        migrateDb(db);
        return true;
      }, true);
      return respond(r === true ? { ok: true } : { ok: false, error: r });
    }

    return respond({ api: true });
  } catch (e) {
    console.error(e);
    return respond({ ok: false, error: "server error" }, 500);
  }
});
