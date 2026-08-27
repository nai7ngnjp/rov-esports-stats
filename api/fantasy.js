// POST /api/fantasy — หลังบ้านของ RoV Fantasy
//
// เก็บข้อมูลไว้ในไฟล์ fantasy.json ในรีโปเดียวกัน ผ่าน GITHUB_TOKEN ที่ตั้งไว้แล้วสำหรับ /api/publish
// จึงไม่ต้องสมัครฐานข้อมูลใหม่ ไม่ต้องตั้งค่าอะไรเพิ่ม
//
// Environment Variables ที่ใช้ (มีอยู่แล้วทั้งหมด): GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH, ADMIN_PASSWORD
//
// actions:
//   {action:"state", name?, pin?}                          → รอบที่เปิดอยู่ + ตารางคะแนน + ทีมของตัวเอง
//   {action:"submit", name, pin, round, squad, captain}    → ส่ง/แก้ทีมของรอบที่ยังไม่ปิด
//   {action:"openRound", password, round, deadline}        → แอดมิน: เปิดรอบพร้อมเดดไลน์
//   {action:"closeRound", password, round}                 → แอดมิน: ปิดรอบทันที
//   {action:"removeEntry", password, name}                 → แอดมิน: ลบผู้เล่นออก
//
// กติกาที่บังคับฝั่งเซิร์ฟเวอร์ (โกงไม่ได้):
//   - ส่งทีมได้เฉพาะรอบที่เปิดอยู่และยังไม่ถึงเดดไลน์ (ใช้นาฬิกาของเซิร์ฟเวอร์)
//   - ทีมของใครของมัน แก้ได้เฉพาะคนที่รู้ PIN ของชื่อนั้น
//   - ทีมของคนอื่นในรอบที่ยังไม่ปิด จะไม่ถูกส่งกลับไปให้ใครเห็น (ลอกกันไม่ได้)

import crypto from "crypto";

const FILE = "fantasy.json";
const EMPTY = { version: 1, rounds: {}, entries: {} };

const sha256 = s => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
const nameKey = s => String(s || "").trim().toLowerCase().replace(/\s+/g, " ");

async function readBody(req) {
  if (req.body != null) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

function ghFetch(token) {
  return (url, opt = {}) => fetch(url, {
    ...opt,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "rov-fantasy",
      ...(opt.headers || {})
    }
  });
}

async function loadStore(gh, repo, branch) {
  const r = await gh(`https://api.github.com/repos/${repo}/contents/${FILE}?ref=${encodeURIComponent(branch)}`);
  if (r.status === 404) return { data: JSON.parse(JSON.stringify(EMPTY)), sha: null };
  if (!r.ok) throw new Error("อ่าน fantasy.json ไม่ได้: " + (await r.text()));
  const j = await r.json();
  let data;
  try { data = JSON.parse(Buffer.from(j.content, "base64").toString("utf-8")); }
  catch (e) { data = JSON.parse(JSON.stringify(EMPTY)); }
  if (!data || typeof data !== "object") data = JSON.parse(JSON.stringify(EMPTY));
  data.rounds = data.rounds || {};
  data.entries = data.entries || {};
  return { data, sha: j.sha };
}

async function saveStore(gh, repo, branch, data, sha, msg) {
  const body = {
    message: msg,
    content: Buffer.from(JSON.stringify(data, null, 1), "utf-8").toString("base64"),
    branch
  };
  if (sha) body.sha = sha;
  const r = await gh(`https://api.github.com/repos/${repo}/contents/${FILE}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return r;
}

// เขียนแบบกันชนกัน: ถ้ามีคนอื่นเขียนแทรกระหว่างทาง อ่านใหม่แล้วลองใหม่
async function mutate(gh, repo, branch, msg, fn) {
  let lastErr = "";
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data, sha } = await loadStore(gh, repo, branch);
    const out = fn(data);
    if (out && out.error) return out;
    const r = await saveStore(gh, repo, branch, data, sha, msg);
    if (r.ok) return out || { ok: true };
    if (r.status === 409 || r.status === 422) {            // ชนกัน → ลองใหม่
      lastErr = await r.text();
      await new Promise(res => setTimeout(res, 220 * (attempt + 1)));
      continue;
    }
    return { error: "บันทึกไม่สำเร็จ: " + (await r.text()), code: 500 };
  }
  return { error: "มีคนกำลังบันทึกพร้อมกันหลายคน ลองใหม่อีกครั้ง " + lastErr, code: 503 };
}

const isOpen = (round, now) => !!round && !round.closed && new Date(round.deadline).getTime() > now;

// ส่งกลับเฉพาะทีมที่เปิดเผยได้: รอบที่ปิดแล้วเห็นได้ทุกคน รอบที่ยังเปิดเห็นได้เฉพาะของตัวเอง
function publicView(data, now, meKey) {
  const rounds = {};
  Object.keys(data.rounds).forEach(k => {
    const r = data.rounds[k];
    rounds[k] = { round: k, deadline: r.deadline, closed: !!r.closed, open: isOpen(r, now) };
  });
  const entries = Object.keys(data.entries).map(k => {
    const e = data.entries[k];
    const squads = {};
    Object.keys(e.squads || {}).forEach(rk => {
      const visible = !isOpen(data.rounds[rk], now) || k === meKey;
      if (visible) squads[rk] = { p: e.squads[rk].p, c: e.squads[rk].c, at: e.squads[rk].at };
      else squads[rk] = { hidden: true, at: e.squads[rk].at };
    });
    return { key: k, name: e.name, joined: e.joined, squads };
  });
  return { rounds, entries, now };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  let body;
  try { body = await readBody(req); } catch (e) { res.status(400).json({ error: "อ่านข้อมูลไม่ได้" }); return; }

  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO;
  const branch = process.env.GITHUB_BRANCH || "main";
  if (!token || !repo) { res.status(500).json({ error: "เซิร์ฟเวอร์ยังไม่ตั้งค่า GITHUB_TOKEN / GITHUB_REPO" }); return; }
  const gh = ghFetch(token);
  const now = Date.now();
  const { action } = body || {};

  const isAdmin = () => process.env.ADMIN_PASSWORD && body.password === process.env.ADMIN_PASSWORD;

  try {
    // ---------- ดูสถานะ ----------
    if (action === "state") {
      const { data } = await loadStore(gh, repo, branch);
      let meKey = null;
      const k = nameKey(body.name);
      if (k && data.entries[k] && body.pin && data.entries[k].pin === sha256(body.pin)) meKey = k;
      res.status(200).json(publicView(data, now, meKey));
      return;
    }

    // ---------- ส่งทีม ----------
    if (action === "submit") {
      const name = String(body.name || "").trim();
      const pin = String(body.pin || "").trim();
      const round = String(body.round || "").trim();
      const squad = Array.isArray(body.squad) ? body.squad.map(x => String(x || "")) : null;
      const captain = String(body.captain || "");

      if (name.length < 2 || name.length > 24) { res.status(400).json({ error: "ชื่อต้องยาว 2–24 ตัวอักษร" }); return; }
      if (!/^\d{4,6}$/.test(pin)) { res.status(400).json({ error: "PIN ต้องเป็นตัวเลข 4–6 หลัก" }); return; }
      if (!squad || squad.length !== 5 || squad.some(x => !x)) { res.status(400).json({ error: "ต้องเลือกครบ 5 ตำแหน่ง" }); return; }
      if (new Set(squad).size !== 5) { res.status(400).json({ error: "มีผู้เล่นซ้ำกันในทีม" }); return; }
      if (!squad.includes(captain)) { res.status(400).json({ error: "กัปตันต้องเป็นคนในทีม" }); return; }

      const out = await mutate(gh, repo, branch, `fantasy: ${name} → ${round}`, data => {
        const r = data.rounds[round];
        if (!r) return { error: "ยังไม่เปิดรับทีมของรอบนี้", code: 400 };
        if (!isOpen(r, now)) return { error: "รอบนี้ปิดรับแล้ว (หมดเวลาส่งทีม)", code: 403 };

        const k = nameKey(name);
        let e = data.entries[k];
        if (!e) {
          e = data.entries[k] = { name, pin: sha256(pin), joined: new Date(now).toISOString(), squads: {} };
        } else if (e.pin !== sha256(pin)) {
          return { error: "ชื่อนี้มีคนใช้แล้ว และ PIN ไม่ตรง — ใช้ชื่ออื่น หรือใส่ PIN ให้ถูก", code: 403 };
        }
        e.name = name;                                        // เก็บตัวพิมพ์ตามที่พิมพ์ล่าสุด
        e.squads[round] = { p: squad, c: captain, at: new Date(now).toISOString() };
        return { ok: true, saved: round };
      });
      if (out.error) { res.status(out.code || 400).json({ error: out.error }); return; }

      const { data } = await loadStore(gh, repo, branch);
      res.status(200).json({ ok: true, saved: out.saved, ...publicView(data, Date.now(), nameKey(name)) });
      return;
    }

    // ---------- แอดมิน ----------
    if (action === "openRound" || action === "closeRound" || action === "removeEntry") {
      if (!process.env.ADMIN_PASSWORD) { res.status(500).json({ error: "เซิร์ฟเวอร์ยังไม่ตั้งค่า ADMIN_PASSWORD" }); return; }
      if (!isAdmin()) { res.status(401).json({ error: "รหัสแอดมินไม่ถูกต้อง" }); return; }

      let msg = "fantasy: admin", apply;
      if (action === "openRound") {
        const round = String(body.round || "").trim();
        const deadline = String(body.deadline || "").trim();
        const t = new Date(deadline).getTime();
        if (!round) { res.status(400).json({ error: "ต้องระบุชื่อรอบ" }); return; }
        if (!isFinite(t)) { res.status(400).json({ error: "รูปแบบเดดไลน์ไม่ถูกต้อง" }); return; }
        if (t <= now) { res.status(400).json({ error: "เดดไลน์ต้องเป็นเวลาในอนาคต" }); return; }
        msg = `fantasy: open ${round}`;
        apply = data => { data.rounds[round] = { deadline: new Date(t).toISOString(), closed: false }; return { ok: true }; };
      } else if (action === "closeRound") {
        const round = String(body.round || "").trim();
        msg = `fantasy: close ${round}`;
        apply = data => {
          if (!data.rounds[round]) return { error: "ไม่พบรอบนี้", code: 404 };
          data.rounds[round].closed = true; return { ok: true };
        };
      } else {
        const k = nameKey(body.name);
        msg = `fantasy: remove ${k}`;
        apply = data => {
          if (!data.entries[k]) return { error: "ไม่พบผู้เล่นคนนี้", code: 404 };
          delete data.entries[k]; return { ok: true };
        };
      }

      const out = await mutate(gh, repo, branch, msg, apply);
      if (out.error) { res.status(out.code || 400).json({ error: out.error }); return; }
      const { data } = await loadStore(gh, repo, branch);
      res.status(200).json({ ok: true, ...publicView(data, Date.now(), null) });
      return;
    }

    res.status(400).json({ error: "ไม่รู้จักคำสั่งนี้" });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
}
