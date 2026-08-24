// POST /api/publish  — เผยแพร่สด: ตรวจรหัสแอดมิน แล้วเขียนข้อมูลใหม่กลับเข้า index.html บน GitHub
// เมื่อ commit สำเร็จ Vercel จะ auto-deploy ทับลิงก์เดิมเองใน ~30 วินาที
// ต้องตั้ง Environment Variables บน Vercel: ADMIN_PASSWORD, GITHUB_TOKEN, GITHUB_REPO (เช่น "nai7ngnjp/rov-esports-stats"), (ไม่บังคับ) GITHUB_BRANCH
//
// รองรับ 3 รูปแบบ body:
//   {password, data}                    → เผยแพร่ทีเดียว (ข้อมูลเล็ก, โหมดเดิม)
//   {password, chunk, i, n}             → อัปชิ้นส่วน → เก็บเป็น git blob → คืน {sha}
//   {password, assemble:[sha,...]}      → ต่อชิ้นส่วนตามลำดับ แล้ว commit
// แบ่งชิ้นเพราะ Vercel จำกัด body ~4.5MB ต่อครั้ง แต่ข้อมูลเว็บโตเกินนั้นแล้ว

async function readBody(req) {
  if (req.body != null) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).send("Method not allowed"); return; }
  try {
    let body;
    try { body = await readBody(req); } catch (e) { res.status(400).send("อ่านข้อมูลไม่ได้"); return; }
    const { password, data, chunk, assemble } = body || {};

    if (!process.env.ADMIN_PASSWORD) { res.status(500).send("เซิร์ฟเวอร์ยังไม่ตั้งค่า ADMIN_PASSWORD"); return; }
    if (!password || password !== process.env.ADMIN_PASSWORD) { res.status(401).send("รหัสไม่ถูกต้อง"); return; }

    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPO;          // "owner/name"
    const branch = process.env.GITHUB_BRANCH || "main";
    if (!token || !repo) { res.status(500).send("เซิร์ฟเวอร์ยังไม่ตั้งค่า GITHUB_TOKEN / GITHUB_REPO"); return; }

    const path = "index.html";
    const api = `https://api.github.com/repos/${repo}/contents/${path}`;
    const gh = (url, opt = {}) => fetch(url, {
      ...opt,
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github+json",
        "User-Agent": "rov-publish",
        ...(opt.headers || {})
      }
    });

    // ---- โหมด A: รับชิ้นส่วน → เก็บเป็น git blob (ยังไม่ commit) ----
    if (typeof chunk === "string") {
      const mk = await gh(`https://api.github.com/repos/${repo}/git/blobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: chunk, encoding: "base64" })
      });
      if (!mk.ok) { res.status(500).send("อัปชิ้นส่วนไม่สำเร็จ: " + (await mk.text())); return; }
      const j = await mk.json();
      res.status(200).json({ sha: j.sha });
      return;
    }

    // ---- เตรียม payload: จากชิ้นส่วน หรือจาก data ก้อนเดียว ----
    let payloadStr;
    if (Array.isArray(assemble)) {
      if (!assemble.length) { res.status(400).send("ไม่มีชิ้นส่วนให้ต่อ"); return; }
      const parts = [];
      for (const sha of assemble) {
        if (!/^[0-9a-f]{40}$/i.test(String(sha))) { res.status(400).send("sha ไม่ถูกต้อง"); return; }
        const b = await gh(`https://api.github.com/repos/${repo}/git/blobs/${sha}`);
        if (!b.ok) { res.status(500).send("อ่านชิ้นส่วนไม่ได้: " + (await b.text())); return; }
        const bj = await b.json();
        parts.push(Buffer.from(bj.content, "base64"));
      }
      payloadStr = Buffer.concat(parts).toString("utf-8");
      try { JSON.parse(payloadStr); }
      catch (e) { res.status(400).send("ชิ้นส่วนที่ต่อแล้วไม่ใช่ JSON ที่ถูกต้อง — ยกเลิกการเขียน"); return; }
    } else {
      if (data == null) { res.status(400).send("ไม่มีข้อมูลส่งมา"); return; }
      payloadStr = typeof data === "string" ? data : JSON.stringify(data);
    }
    payloadStr = payloadStr.replace(/<\//g, "<\\/");

    // 1) อ่านไฟล์ปัจจุบัน — sha จาก contents API, เนื้อหาผ่าน Blobs API (ไฟล์ใหญ่เกิน 1MB contents API คืน content ว่าง)
    const meta = await gh(`${api}?ref=${encodeURIComponent(branch)}`);
    if (!meta.ok) { res.status(500).send("อ่าน index.html จาก GitHub ไม่ได้: " + (await meta.text())); return; }
    const metaJson = await meta.json();
    const fileSha = metaJson.sha;
    let html;
    if (metaJson.content && String(metaJson.content).trim() && metaJson.encoding === "base64") {
      html = Buffer.from(metaJson.content, "base64").toString("utf-8");
    } else {
      const blob = await gh(`https://api.github.com/repos/${repo}/git/blobs/${fileSha}`);
      if (!blob.ok) { res.status(500).send("อ่าน blob ไม่ได้: " + (await blob.text())); return; }
      const blobJson = await blob.json();
      html = Buffer.from(blobJson.content, "base64").toString("utf-8");
    }

    // 2) แทนที่ก้อนข้อมูล saved-data ด้วย payload ใหม่
    const re = /(<script type="application\/json" id="saved-data">)([\s\S]*?)(<\/script>)/;
    if (!re.test(html)) { res.status(500).send("ไม่พบ saved-data ใน index.html"); return; }
    const newHtml = html.replace(re, (m, a, b, c) => a + payloadStr + c);

    // 3) commit กลับ (Vercel จะ auto-deploy เอง)
    const put = await gh(api, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "admin publish: update site data",
        content: Buffer.from(newHtml, "utf-8").toString("base64"),
        sha: fileSha,
        branch
      })
    });
    if (!put.ok) { res.status(500).send("เขียน GitHub ไม่สำเร็จ: " + (await put.text())); return; }

    res.status(200).send("ok");
  } catch (e) {
    res.status(500).send("error: " + String(e));
  }
}
