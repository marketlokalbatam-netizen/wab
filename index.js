const { Client, LocalAuth } = require("whatsapp-web.js");
const express = require("express");
const http = require("http");
const crypto = require("crypto");
const state = require("./state");

// ================= SESSION STORE =================
const sessions = new Map();
const SESSION_COOKIE = "pbot_sid";
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 jam

function genToken() {
    return crypto.randomBytes(32).toString("hex");
}
function parseCookies(req) {
    const raw = req.headers.cookie || "";
    return Object.fromEntries(raw.split(";").map(c => c.trim().split("=").map(decodeURIComponent)));
}
function getSession(req) {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (!token) return false;
    const exp = sessions.get(token);
    if (!exp || Date.now() > exp) { sessions.delete(token); return false; }
    return token;
}
function requireAuth(req, res, next) {
    if (getSession(req)) return next();
    if (req.method === "GET") return res.redirect("/login");
    res.status(401).json({ ok: false, message: "Sesi habis. Silakan login ulang." });
}
setInterval(() => {
    const now = Date.now();
    for (const [token, exp] of sessions) { if (now > exp) sessions.delete(token); }
}, 60 * 60 * 1000);

// ================= ACTIVITY LOG =================
const LOG_MAX = 200;
const botLog = [];
const sseClients = new Set();

function pushLog(type, text) {
    const entry = { t: Date.now(), type, text };
    botLog.push(entry);
    if (botLog.length > LOG_MAX) botLog.shift();
    const payload = `data: ${JSON.stringify(entry)}\n\n`;
    for (const cl of sseClients) { try { cl.write(payload); } catch (_) {} }
}

// ================= STARTUP BANNER =================
console.log("\n=================================");
console.log("   BOT SETORAN - STARTING UP");
console.log("=================================");
console.log("[" + new Date().toLocaleString("id-ID") + "] Inisialisasi bot...");
console.log("---------------------------------\n");
const qrcode = require("qrcode-terminal");
const QRCode = require("qrcode");
const mysql = require("mysql2/promise");
const fs = require("fs");

// ================= EXPRESS UI SERVER =================
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// ================= LOGIN PAGE =================
app.get("/login", (req, res) => {
    if (getSession(req)) return res.redirect("/");
    const err = req.query.err || "";
    res.send(`<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Login — Bot Setoran</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{min-height:100vh;display:flex;align-items:center;justify-content:center;
      background:#0f1117;font-family:'Segoe UI',system-ui,sans-serif;padding:24px}
    .card{background:#1a1d2e;border:1px solid #2d3148;border-radius:20px;
      padding:40px 36px;width:100%;max-width:380px;text-align:center;
      box-shadow:0 8px 40px rgba(0,0,0,0.4)}
    .logo{font-size:2.4rem;margin-bottom:8px}
    h1{font-size:1.15rem;font-weight:700;color:#f8fafc;margin-bottom:4px}
    .sub{font-size:0.82rem;color:#64748b;margin-bottom:28px}
    input[type=password]{width:100%;padding:11px 14px;border-radius:10px;
      border:1px solid #2d3148;background:#0f1117;color:#e2e8f0;
      font-size:0.95rem;outline:none;margin-bottom:12px}
    input[type=password]:focus{border-color:#6366f1}
    .err{color:#f87171;font-size:0.8rem;margin-bottom:12px;min-height:18px}
    button{width:100%;padding:11px;border-radius:10px;border:none;
      background:#6366f1;color:#fff;font-size:0.9rem;font-weight:600;
      cursor:pointer;transition:background 0.2s}
    button:hover{background:#4f52d0}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">⛽</div>
    <h1>Bot Setoran Harian</h1>
    <p class="sub">Masukkan password untuk mengakses panel</p>
    ${err ? `<div class="err">❌ ${err}</div>` : `<div class="err"></div>`}
    <form method="POST" action="/api/login">
      <input type="password" name="password" placeholder="Password..." autofocus autocomplete="current-password"/>
      <button type="submit">Masuk</button>
    </form>
  </div>
</body>
</html>`);
});

app.post("/api/login", express.urlencoded({ extended: false }), (req, res) => {
    const PANEL_PASSWORD = process.env.PANEL_PASSWORD || process.env.RESTART_PASSWORD;
    if (!PANEL_PASSWORD) return res.redirect("/login?err=PANEL_PASSWORD+belum+diset");
    const { password } = req.body || {};
    if (!password || password !== PANEL_PASSWORD) return res.redirect("/login?err=Password+salah");
    const token = genToken();
    sessions.set(token, Date.now() + SESSION_TTL);
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax`);
    res.redirect("/");
});

app.post("/api/logout-panel", (req, res) => {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) sessions.delete(token);
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
    res.json({ ok: true });
});

// ================= PROTECTED APIs =================
app.get("/api/status", requireAuth, (req, res) => {
    res.json({ status: state.status });
});

app.get("/api/qr", requireAuth, (req, res) => {
    if (state.qrDataUrl) {
        res.json({ qr: state.qrDataUrl });
    } else {
        res.json({ qr: null });
    }
});

// ================= API VERIFY PASSWORD =================
app.post("/api/verify-password", requireAuth, (req, res) => {
    const RESTART_PASSWORD = process.env.RESTART_PASSWORD;
    if (!RESTART_PASSWORD) return res.status(503).json({ ok: false, message: "RESTART_PASSWORD belum diset di server." });
    const { password } = req.body || {};
    if (!password || password !== RESTART_PASSWORD) return res.status(401).json({ ok: false, message: "Password salah." });
    res.json({ ok: true });
});

// ================= LOGS SSE =================
app.get("/api/logs/stream", requireAuth, (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    res.write(`data: ${JSON.stringify({ type: "init", log: botLog })}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
});

// ================= LOGS PAGE =================
app.get("/logs", requireAuth, (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Log Aktivitas — Bot Setoran</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0f1117;font-family:'Segoe UI',system-ui,sans-serif;color:#e2e8f0;min-height:100vh}
    .topbar{display:flex;align-items:center;gap:14px;padding:14px 20px;
      background:#1a1d2e;border-bottom:1px solid #2d3148;position:sticky;top:0;z-index:10}
    .topbar a{color:#6366f1;text-decoration:none;font-size:0.85rem}
    .topbar a:hover{text-decoration:underline}
    h1{font-size:1rem;font-weight:700;color:#f8fafc;flex:1}
    .badge-live{background:#16a34a22;color:#4ade80;border:1px solid #16a34a;
      font-size:0.7rem;padding:2px 8px;border-radius:20px;display:flex;align-items:center;gap:5px}
    .dot{width:6px;height:6px;border-radius:50%;background:#4ade80;
      animation:pulse 1.5s infinite}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
    .controls{display:flex;gap:8px;padding:10px 20px;background:#12151f;
      border-bottom:1px solid #1e2235;align-items:center}
    .btn-clear{background:#1e2235;border:1px solid #2d3148;color:#94a3b8;
      padding:5px 12px;border-radius:6px;font-size:0.78rem;cursor:pointer}
    .btn-clear:hover{background:#2d3148}
    .filter-btns{display:flex;gap:6px;flex-wrap:wrap}
    .filter-btn{padding:4px 10px;border-radius:6px;font-size:0.75rem;cursor:pointer;
      border:1px solid transparent;transition:all 0.15s}
    .filter-btn.active{opacity:1!important}
    .filter-btn{opacity:0.55}
    .fb-all{background:#1e2235;border-color:#2d3148;color:#94a3b8}
    .fb-all.active{border-color:#6366f1;color:#6366f1}
    .fb-msg{background:#2e1d5e22;border-color:#6d28d9;color:#a78bfa}
    .fb-msg.active{background:#2e1d5e;border-color:#7c3aed;color:#c4b5fd}
    .fb-ok{background:#14532d22;border-color:#15803d;color:#4ade80}
    .fb-ok.active{background:#14532d;border-color:#16a34a;color:#86efac}
    .fb-warn{background:#78350f22;border-color:#b45309;color:#fbbf24}
    .fb-warn.active{background:#78350f;border-color:#d97706;color:#fde68a}
    .fb-error{background:#7f1d1d22;border-color:#b91c1c;color:#f87171}
    .fb-error.active{background:#7f1d1d;border-color:#dc2626;color:#fca5a5}
    .fb-info{background:#1e3a5f22;border-color:#1d4ed8;color:#60a5fa}
    .fb-info.active{background:#1e3a5f;border-color:#2563eb;color:#93c5fd}
    #log-container{padding:10px 16px;display:flex;flex-direction:column;gap:4px;
      padding-bottom:80px}
    .log-entry{display:flex;align-items:flex-start;gap:10px;padding:8px 12px;
      border-radius:8px;background:#12151f;border:1px solid #1e2235;
      font-size:0.8rem;line-height:1.5;transition:background 0.2s;animation:fadeIn 0.25s ease}
    @keyframes fadeIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
    .log-entry:hover{background:#1a1d2e}
    .log-time{color:#475569;white-space:nowrap;font-size:0.72rem;padding-top:1px;min-width:52px}
    .log-badge{padding:1px 7px;border-radius:4px;font-size:0.68rem;font-weight:700;
      text-transform:uppercase;white-space:nowrap}
    .badge-msg{background:#2e1d5e;color:#c4b5fd}
    .badge-ok{background:#14532d;color:#86efac}
    .badge-warn{background:#78350f;color:#fde68a}
    .badge-error{background:#7f1d1d;color:#fca5a5}
    .badge-info{background:#1e3a5f;color:#93c5fd}
    .log-text{color:#cbd5e1;flex:1;word-break:break-word}
    .empty{text-align:center;color:#334155;padding:60px 20px;font-size:0.85rem}
    .scroll-btn{position:fixed;bottom:20px;right:20px;background:#6366f1;color:#fff;
      border:none;border-radius:50%;width:40px;height:40px;font-size:1.2rem;cursor:pointer;
      display:none;align-items:center;justify-content:center;box-shadow:0 4px 14px rgba(99,102,241,0.4)}
    .scroll-btn.show{display:flex}
  </style>
</head>
<body>
  <div class="topbar">
    <a href="/">← Panel</a>
    <h1>📋 Log Aktivitas Bot</h1>
    <div class="badge-live" id="live-badge"><div class="dot"></div> Live</div>
  </div>
  <div class="controls">
    <div class="filter-btns">
      <button class="filter-btn fb-all active" data-filter="all">Semua</button>
      <button class="filter-btn fb-msg" data-filter="msg">💬 Pesan</button>
      <button class="filter-btn fb-ok" data-filter="ok">✅ Valid</button>
      <button class="filter-btn fb-warn" data-filter="warn">⚠️ Tidak Valid</button>
      <button class="filter-btn fb-error" data-filter="error">❌ Error</button>
      <button class="filter-btn fb-info" data-filter="info">ℹ️ Info</button>
    </div>
    <button class="btn-clear" onclick="clearLog()">Bersihkan</button>
  </div>
  <div id="log-container"><div class="empty" id="empty-msg">Belum ada log. Bot sedang menunggu pesan...</div></div>
  <button class="scroll-btn" id="scroll-btn" title="Scroll ke bawah" onclick="scrollToBottom()">↓</button>

  <script>
    let activeFilter = 'all';
    let entries = [];
    let autoScroll = true;

    const container = document.getElementById('log-container');
    const emptyMsg  = document.getElementById('empty-msg');
    const scrollBtn = document.getElementById('scroll-btn');

    function timeStr(ts) {
      const d = new Date(ts);
      return d.toLocaleTimeString('id-ID', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    }
    function badgeClass(type) {
      return 'badge-' + ({'msg':'msg','ok':'ok','warn':'warn','error':'error','info':'info'}[type] || 'info');
    }
    function badgeLabel(type) {
      return {'msg':'MSG','ok':'OK','warn':'WARN','error':'ERR','info':'INFO'}[type] || type.toUpperCase();
    }
    function renderEntry(e) {
      const el = document.createElement('div');
      el.className = 'log-entry';
      el.dataset.type = e.type;
      el.style.display = (activeFilter === 'all' || activeFilter === e.type) ? 'flex' : 'none';
      el.innerHTML = \`<span class="log-time">\${timeStr(e.t)}</span>
        <span class="log-badge \${badgeClass(e.type)}">\${badgeLabel(e.type)}</span>
        <span class="log-text">\${e.text.replace(/</g,'&lt;')}</span>\`;
      return el;
    }
    function addEntry(e, prepend = false) {
      if (emptyMsg) emptyMsg.remove();
      const el = renderEntry(e);
      if (prepend) { container.prepend(el); } else { container.appendChild(el); }
      if (autoScroll && !prepend) scrollToBottom();
    }
    function scrollToBottom() { window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }); }
    function clearLog() { container.innerHTML = '<div class="empty" id="empty-msg">Log dibersihkan. Menunggu pesan baru...</div>'; entries = []; }

    document.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        activeFilter = btn.dataset.filter;
        document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.log-entry').forEach(el => {
          el.style.display = (activeFilter === 'all' || activeFilter === el.dataset.type) ? 'flex' : 'none';
        });
      });
    });

    window.addEventListener('scroll', () => {
      const nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
      autoScroll = nearBottom;
      scrollBtn.classList.toggle('show', !nearBottom && entries.length > 10);
    });

    const liveBadge = document.getElementById('live-badge');
    function connectSSE() {
      const es = new EventSource('/api/logs/stream');
      es.onopen = () => { liveBadge.style.display = 'flex'; };
      es.onerror = () => { liveBadge.style.display = 'none'; setTimeout(connectSSE, 3000); };
      es.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'init') {
          data.log.forEach(e => { entries.push(e); addEntry(e); });
          if (autoScroll) scrollToBottom();
        } else {
          entries.push(data);
          addEntry(data);
        }
      };
    }
    connectSSE();
  </script>
</body>
</html>`);
});

// ================= API RESTART =================
function checkPassword(req, res) {
    const RESTART_PASSWORD = process.env.RESTART_PASSWORD;
    if (!RESTART_PASSWORD) {
        res.status(503).json({ ok: false, message: "RESTART_PASSWORD belum diset di server." });
        return false;
    }
    const { password } = req.body || {};
    if (!password || password !== RESTART_PASSWORD) {
        res.status(401).json({ ok: false, message: "Password salah." });
        return false;
    }
    return true;
}

app.post("/api/restart", requireAuth, async (req, res) => {
    if (!checkPassword(req, res)) return;
    res.json({ ok: true, message: "Restart sedang diproses..." });
    console.log("[RESTART] Permintaan restart diterima.");
    state.status = "starting";
    state.qrDataUrl = null;
    try {
        await client.destroy();
        console.log("[RESTART] Client dihancurkan. Reinisialisasi dalam 3 detik...");
    } catch (e) {
        console.log("[RESTART] destroy error (diabaikan):", e?.message);
    }
    setTimeout(async () => {
        cleanLocks();
        try {
            await client.initialize();
            console.log("[RESTART] Client diinisialisasi ulang.");
        } catch (err) {
            console.log("[RESTART] Gagal reinisialisasi:", err?.message || err);
            state.status = "disconnected";
        }
    }, 3000);
});

app.post("/api/restart-server", requireAuth, async (req, res) => {
    if (!checkPassword(req, res)) return;
    res.json({ ok: true, message: "Server akan direstart dalam 2 detik..." });
    console.log("[RESTART-SERVER] Permintaan restart server diterima. Proses akan exit...");
    setTimeout(() => {
        process.exit(0);
    }, 2000);
});

app.post("/api/logout", requireAuth, async (req, res) => {
    if (!checkPassword(req, res)) return;
    res.json({ ok: true, message: "Logout sedang diproses..." });
    console.log("[LOGOUT] Permintaan logout diterima.");
    state.status = "starting";
    state.qrDataUrl = null;
    try {
        await client.logout();
        console.log("[LOGOUT] Sesi WhatsApp dihapus.");
    } catch (e) {
        console.log("[LOGOUT] logout error (diabaikan):", e?.message);
    }
    try {
        await client.destroy();
        console.log("[LOGOUT] Client dihancurkan.");
    } catch (e) {
        console.log("[LOGOUT] destroy error (diabaikan):", e?.message);
    }
    setTimeout(async () => {
        cleanLocks();
        try {
            await client.initialize();
            console.log("[LOGOUT] Client diinisialisasi ulang — scan QR baru.");
        } catch (err) {
            console.log("[LOGOUT] Gagal reinisialisasi:", err?.message || err);
            state.status = "disconnected";
        }
    }, 3000);
});

app.get("/", requireAuth, (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Bot Setoran — Panel</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: #0f1117;
      font-family: 'Segoe UI', system-ui, sans-serif;
      color: #e2e8f0;
      padding: 24px;
    }

    .card {
      background: #1a1d2e;
      border: 1px solid #2d3148;
      border-radius: 20px;
      padding: 40px 36px;
      width: 100%;
      max-width: 420px;
      text-align: center;
      box-shadow: 0 8px 40px rgba(0,0,0,0.4);
    }

    .logo {
      font-size: 2.4rem;
      margin-bottom: 6px;
    }

    h1 {
      font-size: 1.25rem;
      font-weight: 700;
      color: #f8fafc;
      margin-bottom: 4px;
    }

    .subtitle {
      font-size: 0.85rem;
      color: #64748b;
      margin-bottom: 28px;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 16px;
      border-radius: 999px;
      font-size: 0.82rem;
      font-weight: 600;
      margin-bottom: 28px;
      transition: all 0.3s;
    }
    .badge.starting     { background: #1e2a45; color: #60a5fa; border: 1px solid #2563eb44; }
    .badge.qr           { background: #1e2a20; color: #4ade80; border: 1px solid #16a34a44; }
    .badge.ready        { background: #14291a; color: #22c55e; border: 1px solid #16a34a; }
    .badge.disconnected { background: #2d1b1b; color: #f87171; border: 1px solid #dc262644; }
    .badge.auth_failure { background: #2d1b1b; color: #f87171; border: 1px solid #dc262644; }

    .dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: currentColor;
    }
    .dot.pulse {
      animation: pulse 1.4s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50%       { opacity: 0.4; transform: scale(0.8); }
    }

    #qr-area { margin-bottom: 20px; }

    #qr-img {
      width: 240px;
      height: 240px;
      border-radius: 12px;
      background: #fff;
      padding: 10px;
      display: none;
      margin: 0 auto 14px;
    }

    #qr-hint {
      font-size: 0.82rem;
      color: #94a3b8;
      line-height: 1.6;
    }

    #ready-icon {
      font-size: 3.5rem;
      margin-bottom: 12px;
      display: none;
    }

    #ready-text {
      font-size: 1rem;
      color: #22c55e;
      font-weight: 600;
      display: none;
      margin-bottom: 6px;
    }

    #ready-sub {
      font-size: 0.82rem;
      color: #64748b;
      display: none;
    }

    #spinner {
      width: 48px; height: 48px;
      border: 3px solid #2d3148;
      border-top: 3px solid #6366f1;
      border-radius: 50%;
      animation: spin 0.9s linear infinite;
      margin: 0 auto 16px;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    #spinner-text {
      font-size: 0.85rem;
      color: #64748b;
    }

    .footer {
      margin-top: 28px;
      font-size: 0.75rem;
      color: #334155;
    }

    .refresh-note {
      margin-top: 20px;
      font-size: 0.75rem;
      color: #475569;
    }

    .btn-restart {
      margin-top: 20px;
      width: 100%;
      padding: 10px 0;
      border: 1px solid #3f3f5a;
      border-radius: 10px;
      background: #1e2040;
      color: #94a3b8;
      font-size: 0.82rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s, color 0.2s, border-color 0.2s;
    }
    .btn-restart:hover {
      background: #2d2f55;
      color: #e2e8f0;
      border-color: #6366f1;
    }
    .btn-restart:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .btn-logout {
      border-color: #5a1e1e;
      background: #2d1414;
      color: #f87171;
    }
    .btn-logout:hover {
      background: #3d1a1a;
      color: #fca5a5;
      border-color: #dc2626;
    }

    .btn-server {
      border-color: #3d2e00;
      background: #241a00;
      color: #fbbf24;
      width: 100%;
      margin-top: 8px;
    }
    .btn-server:hover {
      background: #3a2800;
      color: #fcd34d;
      border-color: #d97706;
    }

    .modal-overlay {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.6);
      backdrop-filter: blur(4px);
      align-items: center;
      justify-content: center;
      z-index: 100;
    }
    .modal-overlay.open { display: flex; }

    .modal {
      background: #1a1d2e;
      border: 1px solid #2d3148;
      border-radius: 16px;
      padding: 32px 28px;
      width: 100%;
      max-width: 340px;
      text-align: center;
      box-shadow: 0 12px 48px rgba(0,0,0,0.5);
    }
    .modal h2 {
      font-size: 1.05rem;
      font-weight: 700;
      color: #f8fafc;
      margin-bottom: 6px;
    }
    .modal p {
      font-size: 0.82rem;
      color: #64748b;
      margin-bottom: 20px;
    }
    .modal input[type="password"] {
      width: 100%;
      padding: 10px 14px;
      border-radius: 8px;
      border: 1px solid #2d3148;
      background: #0f1117;
      color: #e2e8f0;
      font-size: 0.9rem;
      outline: none;
      margin-bottom: 8px;
    }
    .modal input[type="password"]:focus {
      border-color: #6366f1;
    }
    #modal-error {
      font-size: 0.78rem;
      color: #f87171;
      min-height: 18px;
      margin-bottom: 14px;
    }
    .modal-actions {
      display: flex;
      gap: 10px;
    }
    .btn-cancel {
      flex: 1;
      padding: 10px 0;
      border-radius: 8px;
      border: 1px solid #2d3148;
      background: transparent;
      color: #64748b;
      font-size: 0.85rem;
      cursor: pointer;
      transition: background 0.2s;
    }
    .btn-cancel:hover { background: #1e2040; }

    .btn-confirm {
      flex: 1;
      padding: 10px 0;
      border-radius: 8px;
      border: none;
      background: #6366f1;
      color: #fff;
      font-size: 0.85rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    .btn-confirm:hover { background: #4f52d0; }
    .btn-confirm:disabled { opacity: 0.5; cursor: not-allowed; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">⛽</div>
    <h1>Bot Setoran Harian</h1>
    <p class="subtitle">Panel Manajemen WhatsApp Bot</p>

    <div id="badge" class="badge starting">
      <div class="dot pulse"></div>
      <span id="badge-text">Memulai...</span>
    </div>

    <div id="view-loading">
      <div id="spinner"></div>
      <p id="spinner-text">Menghubungkan ke WhatsApp...</p>
    </div>

    <div id="view-qr" style="display:none">
      <div id="qr-area">
        <img id="qr-img" src="" alt="QR Code" />
        <p id="qr-hint">
          Buka WhatsApp di HP Anda<br/>
          <strong>Perangkat Tertaut → Tautkan Perangkat</strong><br/>
          lalu scan QR di atas
        </p>
      </div>
    </div>

    <div id="view-ready" style="display:none">
      <div id="ready-icon">✅</div>
      <p id="ready-text">Bot Aktif & Terhubung</p>
      <p id="ready-sub">Bot sedang berjalan dan memantau laporan di grup WhatsApp.</p>
    </div>

    <div id="view-error" style="display:none">
      <div style="font-size:3rem;margin-bottom:12px">❌</div>
      <p style="color:#f87171;font-weight:600;margin-bottom:6px">Koneksi Terputus</p>
      <p style="font-size:0.82rem;color:#64748b">Bot akan mencoba reconnect otomatis dalam beberapa detik...</p>
    </div>

    <p class="refresh-note">Halaman diperbarui otomatis setiap 3 detik</p>
    <div style="display:flex;gap:10px;margin-top:20px;">
      <button class="btn-restart" id="btn-restart" style="margin-top:0;flex:1" onclick="openModal('restart')">🔄 Restart Bot</button>
      <button class="btn-restart btn-logout" id="btn-logout" style="margin-top:0;flex:1" onclick="openModal('logout')">🚪 Logout Sesi</button>
    </div>
    <button class="btn-restart btn-server" id="btn-server" onclick="openModal('server')">⚡ Restart Server</button>
  </div>

  <div class="footer">Bot Setoran &copy; ${new Date().getFullYear()} &nbsp;·&nbsp;
    <a href="/logs" style="color:#6366f1;text-decoration:none;font-size:0.78rem;">📋 Log Aktivitas</a>
    &nbsp;·&nbsp;
    <a href="#" onclick="logoutPanel()" style="color:#64748b;text-decoration:none;font-size:0.78rem;">Keluar Panel</a>
  </div>

  <!-- MODAL DUA LANGKAH -->
  <div class="modal-overlay" id="modal-overlay">
    <div class="modal">
      <h2 id="modal-title">🔒 Konfirmasi</h2>

      <!-- LANGKAH 1: Masukkan password -->
      <div id="modal-step1">
        <p id="modal-desc" style="margin-bottom:14px;color:#94a3b8;font-size:0.88rem;line-height:1.5"></p>
        <input type="password" id="modal-pass" placeholder="Password admin..." />
        <div id="modal-error-1" style="color:#f87171;font-size:0.8rem;min-height:18px;margin-bottom:6px"></div>
        <div class="modal-actions">
          <button class="btn-cancel" onclick="closeModal()">Batal</button>
          <button class="btn-confirm" id="btn-step1-next" onclick="verifyPassword()">Verifikasi →</button>
        </div>
      </div>

      <!-- LANGKAH 2: Konfirmasi akhir -->
      <div id="modal-step2" style="display:none">
        <p id="modal-confirm-text" style="margin-bottom:20px;color:#94a3b8;font-size:0.88rem;line-height:1.5;text-align:center"></p>
        <div style="background:#1e1b2e;border:1px solid #3d3660;border-radius:10px;padding:12px 14px;margin-bottom:16px;font-size:0.82rem;color:#a78bfa;text-align:center">
          ⚠️ Tindakan ini tidak dapat dibatalkan setelah dimulai.
        </div>
        <div id="modal-error-2" style="color:#f87171;font-size:0.8rem;min-height:18px;margin-bottom:6px"></div>
        <div class="modal-actions">
          <button class="btn-cancel" onclick="closeModal()">Batal</button>
          <button class="btn-confirm" id="btn-execute" onclick="executeAction()">Ya, Lanjutkan</button>
        </div>
      </div>
    </div>
  </div>

  <script>
    let lastStatus = null;

    function showView(name) {
      ['loading','qr','ready','error'].forEach(v => {
        document.getElementById('view-' + v).style.display = (v === name) ? 'block' : 'none';
      });
    }

    function setBadge(status) {
      const badge = document.getElementById('badge');
      const text  = document.getElementById('badge-text');
      badge.className = 'badge ' + status;
      const dot = badge.querySelector('.dot');
      const labels = {
        starting:     'Memulai...',
        qr:           'Menunggu Scan QR',
        ready:        'Bot Aktif',
        disconnected: 'Terputus — Reconnecting',
        auth_failure: 'Autentikasi Gagal',
      };
      text.textContent = labels[status] || status;
      if (status === 'ready') { dot.classList.remove('pulse'); } else { dot.classList.add('pulse'); }
    }

    async function poll() {
      try {
        const res  = await fetch('/api/status');
        if (res.status === 401) { window.location.href = '/login'; return; }
        const data = await res.json();
        const status = data.status;
        setBadge(status);
        if (status === 'qr') {
          showView('qr');
          const qrRes  = await fetch('/api/qr');
          const qrData = await qrRes.json();
          if (qrData.qr) {
            const img = document.getElementById('qr-img');
            img.src = qrData.qr;
            img.style.display = 'block';
          }
        } else if (status === 'ready') {
          showView('ready');
          document.getElementById('ready-icon').style.display = 'block';
          document.getElementById('ready-text').style.display = 'block';
          document.getElementById('ready-sub').style.display  = 'block';
        } else if (status === 'disconnected' || status === 'auth_failure') {
          showView('error');
        } else {
          showView('loading');
        }
        lastStatus = status;
      } catch (e) {
        showView('loading');
      }
    }

    poll();
    setInterval(poll, 3000);

    // ===== MODAL DUA LANGKAH =====
    let currentAction = 'restart';
    let verifiedPassword = '';

    const ACTION_CONFIG = {
      restart: {
        title: '🔄 Restart Bot',
        desc:  'Bot WhatsApp akan direstart. Masukkan password admin untuk melanjutkan.',
        confirm: 'Yakin ingin merestart bot WhatsApp sekarang?',
        btnText: 'Ya, Restart Bot',
        btnColor: '#6366f1',
        execBtnId: 'btn-restart',
        execLabel: '🔄 Restart Bot',
        processingLabel: '🔄 Restarting...',
        endpoint: '/api/restart',
        timeout: 15000,
      },
      logout: {
        title: '🚪 Logout Sesi WhatsApp',
        desc:  'Sesi WhatsApp akan dihapus dan bot akan meminta scan QR ulang. Masukkan password admin.',
        confirm: 'Yakin ingin logout sesi WhatsApp? Anda perlu scan QR lagi setelahnya.',
        btnText: 'Ya, Logout Sekarang',
        btnColor: '#dc2626',
        execBtnId: 'btn-logout',
        execLabel: '🚪 Logout Sesi',
        processingLabel: '🚪 Logging out...',
        endpoint: '/api/logout',
        timeout: 15000,
      },
      server: {
        title: '⚡ Restart Server',
        desc:  'Seluruh proses server akan direstart. Panel akan offline sebentar. Masukkan password admin.',
        confirm: 'Yakin ingin merestart seluruh proses server? Panel akan tidak tersedia sebentar.',
        btnText: 'Ya, Restart Server',
        btnColor: '#d97706',
        execBtnId: 'btn-server',
        execLabel: '⚡ Restart Server',
        processingLabel: '⚡ Server restarting...',
        endpoint: '/api/restart-server',
        timeout: 20000,
      },
    };

    function openModal(action) {
      currentAction = action;
      verifiedPassword = '';
      const cfg = ACTION_CONFIG[action];

      document.getElementById('modal-title').textContent = cfg.title;
      document.getElementById('modal-desc').textContent  = cfg.desc;
      document.getElementById('modal-pass').value = '';
      document.getElementById('modal-error-1').textContent = '';
      document.getElementById('modal-error-2').textContent = '';
      document.getElementById('btn-step1-next').disabled = false;
      document.getElementById('btn-step1-next').textContent = 'Verifikasi →';
      document.getElementById('btn-step1-next').style.background = cfg.btnColor;

      document.getElementById('modal-confirm-text').textContent = cfg.confirm;
      document.getElementById('btn-execute').textContent = cfg.btnText;
      document.getElementById('btn-execute').style.background = cfg.btnColor;
      document.getElementById('btn-execute').disabled = false;

      document.getElementById('modal-step1').style.display = 'block';
      document.getElementById('modal-step2').style.display = 'none';
      document.getElementById('modal-overlay').classList.add('open');
      setTimeout(() => document.getElementById('modal-pass').focus(), 100);
    }

    function closeModal() {
      document.getElementById('modal-overlay').classList.remove('open');
    }

    document.getElementById('modal-overlay').addEventListener('click', function(e) {
      if (e.target === this) closeModal();
    });

    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') closeModal();
      if (e.key === 'Enter' && document.getElementById('modal-overlay').classList.contains('open')) {
        const step2 = document.getElementById('modal-step2');
        if (step2.style.display !== 'none') { executeAction(); } else { verifyPassword(); }
      }
    });

    async function verifyPassword() {
      const pass = document.getElementById('modal-pass').value.trim();
      const errEl = document.getElementById('modal-error-1');
      const btn   = document.getElementById('btn-step1-next');
      if (!pass) { errEl.textContent = 'Password tidak boleh kosong.'; return; }

      btn.disabled = true;
      btn.textContent = 'Memeriksa...';
      errEl.textContent = '';

      try {
        const res  = await fetch('/api/verify-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pass }),
        });
        const data = await res.json();
        if (data.ok) {
          verifiedPassword = pass;
          document.getElementById('modal-step1').style.display = 'none';
          document.getElementById('modal-step2').style.display = 'block';
        } else {
          errEl.textContent = data.message || 'Password salah.';
          btn.disabled = false;
          btn.textContent = 'Verifikasi →';
        }
      } catch (e) {
        errEl.textContent = 'Koneksi error. Coba lagi.';
        btn.disabled = false;
        btn.textContent = 'Verifikasi →';
      }
    }

    async function executeAction() {
      const errEl = document.getElementById('modal-error-2');
      const btn   = document.getElementById('btn-execute');
      const cfg   = ACTION_CONFIG[currentAction];

      btn.disabled = true;
      btn.textContent = 'Memproses...';
      errEl.textContent = '';

      try {
        const res  = await fetch(cfg.endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: verifiedPassword }),
        });
        const data = await res.json();
        if (data.ok) {
          closeModal();
          const execBtn = document.getElementById(cfg.execBtnId);
          execBtn.disabled = true;
          execBtn.textContent = cfg.processingLabel;
          setTimeout(() => {
            execBtn.disabled = false;
            execBtn.textContent = cfg.execLabel;
          }, cfg.timeout);
        } else {
          errEl.textContent = data.message || 'Gagal. Coba lagi.';
          btn.disabled = false;
          btn.textContent = cfg.btnText;
        }
      } catch (e) {
        errEl.textContent = 'Koneksi error. Coba lagi.';
        btn.disabled = false;
        btn.textContent = cfg.btnText;
      }
    }

    async function logoutPanel() {
      await fetch('/api/logout-panel', { method: 'POST' });
      window.location.href = '/login';
    }
  </script>
</body>
</html>`);
});

app.listen(PORT, "0.0.0.0", () => {
    console.log("[SERVER] UI berjalan di port " + PORT);
});

setInterval(() => {
    http.get("http://localhost:" + PORT + "/api/status", (res) => {
        console.log("🏓 Ping:", res.statusCode);
    }).on("error", (err) => {
        console.log("⚠️ Ping error:", err.message);
    });
}, 30000);

// ================= CLEANUP =================
function cleanLocks() {
    const lockFiles = ["SingletonLock", "SingletonSocket", "SingletonCookie", "DevToolsActivePort"];
    const base = ".wwebjs_auth/session-bot-setoran";
    lockFiles.forEach((f) => {
        const p = base + "/" + f;
        try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
    });
    const p2 = base + "/Default/" + "DevToolsActivePort";
    try { if (fs.existsSync(p2)) fs.unlinkSync(p2); } catch (_) {}
    console.log("[CLEANUP] Lock files dihapus.");
}
cleanLocks();

// ================= WHATSAPP =================
const client = new Client({
    authStrategy: new LocalAuth({
        clientId: "bot-setoran",
    }),
    puppeteer: {
        headless: true,
        ...((() => {
            const custom = process.env.CHROMIUM_PATH;
            const replit = "/nix/store/qa9cnw4v5xkxyip6mb9kxqfq1z4x2dx1-chromium-138.0.7204.100/bin/chromium";
            if (custom) return { executablePath: custom };
            if (fs.existsSync(replit)) return { executablePath: replit };
            return {};
        })()),
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-accelerated-2d-canvas",
            "--no-first-run",
            "--no-zygote",
            "--disable-gpu",
            "--disable-extensions",
            "--disable-background-networking",
        ],
    },
});

// ================= DATABASE =================
const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: Number(process.env.DB_PORT) || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
});

// ================= QR =================
client.on("qr", async (qr) => {
    console.log("📱 SCAN QR INI");
    qrcode.generate(qr, { small: true });
    state.status = "qr";
    state.qrDataUrl = await QRCode.toDataURL(qr, { width: 300, margin: 2 });
    pushLog("info", "QR code baru digenerate — menunggu scan dari WhatsApp.");
});

// ================= READY =================
client.on("ready", async () => {
    console.log("✅ BOT SIAP");
    state.status = "ready";
    state.qrDataUrl = null;
    pushLog("ok", "Bot WhatsApp siap dan terhubung.");

    try {
        const conn = await db.getConnection();
        console.log("✅ DATABASE CONNECTED");
        conn.release();
        pushLog("ok", "Koneksi database berhasil.");
    } catch (err) {
        console.log("❌ DATABASE ERROR");
        console.log(err);
        pushLog("error", "Koneksi database gagal: " + (err?.message || err));
    }
});

// ================= AUTH =================
client.on("authenticated", () => {
    console.log("✅ AUTH SUCCESS");
});

client.on("auth_failure", (msg) => {
    console.log("❌ AUTH FAILED", msg);
    state.status = "auth_failure";
    state.qrDataUrl = null;
    pushLog("error", "Autentikasi WhatsApp gagal: " + msg);
});

// ================= LOADING =================
client.on("loading_screen", (percent, message) => {
    console.log("Loading...", percent, message);
});

// ================= DISCONNECTED - AUTO RECONNECT =================
client.on("disconnected", (reason) => {
    console.log("[DISCONNECTED]", reason);
    state.status = "disconnected";
    state.qrDataUrl = null;
    pushLog("warn", "Bot terputus: " + reason + " — mencoba reconnect dalam 5 detik...");
    console.log("[RECONNECT] Mencoba reconnect dalam 5 detik...");
    setTimeout(() => {
        cleanLocks();
        client.initialize();
    }, 5000);
});

// ================= HELPER =================
function getNumber(text, regex) {
    const match = text.match(regex);
    if (!match) return 0;
    return parseFloat(match[1].replace(/\./g, "").replace(",", ".")) || 0;
}

// ================= SUMMARY =================
async function handleSummary(message, args) {
    const now = new Date();
    let bulan = String(now.getMonth() + 1).padStart(2, "0");
    let tahun = String(now.getFullYear());

    if (args.length >= 2) {
        bulan = String(args[0]).padStart(2, "0");
        tahun = String(args[1]);
    } else if (args.length === 1) {
        bulan = String(args[0]).padStart(2, "0");
    }

    const namaBulan = {
        "01": "Januari", "02": "Februari", "03": "Maret",
        "04": "April",   "05": "Mei",      "06": "Juni",
        "07": "Juli",    "08": "Agustus",  "09": "September",
        "10": "Oktober", "11": "November", "12": "Desember",
    };

    const [rows] = await db.execute(
        `SELECT
            COUNT(*) AS jumlah_laporan,
            SUM(cash) AS total_cash,
            SUM(qris) AS total_qris,
            SUM(cash + qris) AS total_uang,
            SUM(total_liter) AS total_liter,
            SUM(nomor_akhir - nomor_awal) AS total_tera,
            SUM(total_setoran) AS total_setoran,
            SUM(total_pengeluaran) AS total_pengeluaran,
            SUM(total_pemasukan) AS total_pemasukan,
            SUM(total_keseluruhan) AS total_keseluruhan
         FROM setoran
         WHERE MONTH(tanggal) = ?
           AND YEAR(tanggal) = ?`,
        [Number(bulan), Number(tahun)],
    );

    const d = rows[0];

    if (!d || Number(d.jumlah_laporan) === 0) {
        return await message.reply(
            `📭 Tidak ada data setoran untuk bulan *${namaBulan[bulan] || bulan} ${tahun}*`,
        );
    }

    const fmt  = (n) => Number(n || 0).toLocaleString("id-ID");
    const fmtL = (n) => Number(n || 0).toFixed(2);

    await message.reply(
        `📊 *SUMMARY SETORAN*
📅 ${namaBulan[bulan] || bulan} ${tahun}
━━━━━━━━━━━━━━━━━━
📋 Jumlah Laporan   : ${d.jumlah_laporan}
⛽ Total Liter      : ${fmtL(d.total_liter)} L
🔢 Total Tera       : ${fmtL(d.total_tera)}
━━━━━━━━━━━━━━━━━━
💵 Cash             : Rp ${fmt(d.total_cash)}
📱 QRIS             : Rp ${fmt(d.total_qris)}
💰 Total Uang       : Rp ${fmt(d.total_uang)}
━━━━━━━━━━━━━━━━━━
📤 Total Pengeluaran: Rp ${fmt(d.total_pengeluaran)}
📥 Total Pemasukan  : Rp ${fmt(d.total_pemasukan)}
━━━━━━━━━━━━━━━━━━
🏦 Total Setoran    : Rp ${fmt(d.total_setoran)}
━━━━━━━━━━━━━━━━━━
💼 *Total Keseluruhan*
*Rp ${fmt(d.total_keseluruhan)}*`,
    );
}

// ================= MESSAGE =================
client.on("message", async (message) => {
    try {
        console.log("[MSG] from:", message.from, "| fromMe:", message.fromMe, "| body:", message.body.substring(0, 50));

        if (!message.from.includes("@g.us")) return;
        if (message.fromMe) return;

        if (message.body.toLowerCase().startsWith("/summary")) {
            const args = message.body.trim().split(/\s+/).slice(1);
            pushLog("msg", `Perintah /summary diterima dari grup ${message.from}`);
            return await handleSummary(message, args);
        }

        if (!message.body.includes("Setoran Harian")) return;
        pushLog("msg", `Laporan masuk dari grup ${message.from}: "${message.body.substring(0, 60).replace(/\n/g, ' ')}..."`);

        const body = message.body;

        const nama = body.match(/Nama\s*:?\s*(.+)/i)?.[1]?.trim() || "-";

        const jamMatch = body.match(/Jam\s*:?\s*\(?\s*(\d{1,2}):(\d{2})/i);
        const jamLaporanMin = jamMatch
            ? Number(jamMatch[1]) * 60 + Number(jamMatch[2])
            : null;

        const bulanMap = {
            januari: "01", februari: "02", maret: "03",
            april: "04",   mei: "05",      juni: "06",
            juli: "07",    agustus: "08",  september: "09",
            oktober: "10", november: "11", desember: "12",
        };

        const tanggalMatch = body.match(
            /(Senin|Selasa|Rabu|Kamis|Jumat|Sabtu|Minggu),\s*(\d+)\s+([A-Za-z]+)\s+(\d{4})/i,
        );

        const tanggalLaporan = tanggalMatch?.[0] || "-";
        let tanggalDB = "-";

        if (tanggalMatch) {
            const hari  = tanggalMatch[2].padStart(2, "0");
            const bulan = bulanMap[tanggalMatch[3].toLowerCase()] || "00";
            const tahun = tanggalMatch[4];
            tanggalDB = `${tahun}-${bulan}-${hari}`;
        }

        const cash       = getNumber(body, /Cash\s*:?\s*Rp?\s*([\d.,]+)/i);
        const qris       = getNumber(body, /QRIS\s*:?\s*Rp?\s*([\d.,]+)/i);
        const pengeluaran = getNumber(body, /Total Pengeluaran\s*:?\s*Rp?\s*([\d.,]+)/i);
        const pemasukan  = getNumber(body, /Total Pemasukan\s*:?\s*Rp?\s*([\d.,]+)/i);
        const keseluruhan = getNumber(body, /Total Keseluruhan\s*:?\s*Rp?\s*([\d.,]+)/i);
        const awal       = getNumber(body, /Nomor Awal\s*:?\s*([\d.,]+)/i);
        const akhir      = getNumber(body, /Nomor Akhir\s*:?\s*([\d.,]+)/i);
        const totalLiter = getNumber(body, /Total Liter\s*:?\s*([\d.,]+)/i);

        const liter    = akhir - awal;
        const totalUang = cash + qris;
        const setor    = cash - pengeluaran + pemasukan;

        console.log("NAMA:", nama);
        console.log("TANGGAL LAPORAN:", tanggalLaporan);
        console.log("TANGGAL DB:", tanggalDB);

        const [rows] = await db.execute(
            `SELECT * FROM setoran
             WHERE LOWER(employee_name) = LOWER(?)
             AND tanggal = ?`,
            [nama, tanggalDB],
        );
        console.log("NAMA BOT :", nama);
        console.log("TANGGAL BOT :", tanggalDB);

        if (!rows.length) {
            pushLog("warn", `Data tidak ditemukan — Nama: ${nama}, Tanggal: ${tanggalDB}`);
            return await message.reply(
                `❌ Data tidak ditemukan untuk *${nama}*\n` +
                `📅 Tanggal : ${tanggalLaporan}\n` +
                `\nPastikan laporan sudah diisi di Link.`,
            );
        }

        const toMin = (s) => {
            if (!s) return null;
            const p = s.split(":");
            return Number(p[0]) * 60 + Number(p[1]);
        };
        const dbData =
            jamLaporanMin !== null
                ? rows.reduce((best, row) => {
                      const masuk = toMin(row.jam_masuk);
                      if (masuk === null) return best;
                      const diff = Math.abs(jamLaporanMin - masuk);
                      if (!best) return { row, diff };
                      return diff < best.diff ? { row, diff } : best;
                  }, null)?.row || rows[0]
                : rows[0];

        const shift = dbData.shift || "-";
        console.log(
            "JAM LAPORAN :", jamLaporanMin,
            "| JAM MASUK DB :", dbData.jam_masuk,
            "| SHIFT DB :", shift,
        );

        const validLiter      = Math.abs(Number(dbData.total_liter) - totalLiter) < 0.01;
        const validCash       = Math.abs(Number(dbData.cash) - cash) < 1;
        const validQris       = Math.abs(Number(dbData.qris) - qris) < 1;
        const validKeseluruhan = Math.abs(Number(dbData.total_keseluruhan) - keseluruhan) < 1;
        const valid = validLiter && validCash && validQris && validKeseluruhan;

        console.log("VALID:", valid, "| Liter:", validLiter, "| Cash:", validCash, "| QRIS:", validQris, "| Keseluruhan:", validKeseluruhan);

        if (valid) {
            console.log("[REPLY] Mengirim balasan VALID...");
            pushLog("ok", `Laporan VALID — ${nama} | Tanggal: ${tanggalLaporan} | Shift: ${shift}`);
            await message.reply(
                `✅ Laporan Pas ${nama}
📅 Tanggal : ${tanggalLaporan}
🕐 Shift   : ${shift}
━━━━━━━━━━━━━━━━━━
⛽ Liter         : ${liter.toFixed(2)} L
📱 Total QRIS    : Rp ${qris.toLocaleString("id-ID")}
💵 Total Cash    : Rp ${cash.toLocaleString("id-ID")}
💰 Total Seluruh : Rp ${totalUang.toLocaleString("id-ID")}
━━━━━━━━━━━━━━━━━━
📤 Pengeluaran : Rp ${pengeluaran.toLocaleString("id-ID")}
📥 Pemasukan   : Rp ${pemasukan.toLocaleString("id-ID")}
━━━━━━━━━━━━━━━━━━
🏦 yang harus di Stor *Rp ${setor.toLocaleString("id-ID")}*`,
            );
        } else {
            console.log("[REPLY] Mengirim balasan TIDAK VALID...");
            pushLog("warn", `Laporan TIDAK VALID — ${nama} | Tanggal: ${tanggalLaporan} | Shift: ${shift}`);

            const selisihLiter       = totalLiter - Number(dbData.total_liter);
            const selisihCash        = cash - Number(dbData.cash);
            const selisihQris        = qris - Number(dbData.qris);
            const selisihKeseluruhan = keseluruhan - Number(dbData.total_keseluruhan);

            const statusLiter = selisihLiter < 0
                ? `Kurang ${Math.abs(selisihLiter).toFixed(2)} L`
                : `Lebih ${Math.abs(selisihLiter).toFixed(2)} L`;

            const statusCash = selisihCash < 0
                ? `Kurang Rp ${Math.abs(selisihCash).toLocaleString("id-ID")}`
                : `Lebih Rp ${Math.abs(selisihCash).toLocaleString("id-ID")}`;

            const statusQris = selisihQris < 0
                ? `Kurang Rp ${Math.abs(selisihQris).toLocaleString("id-ID")}`
                : `Lebih Rp ${Math.abs(selisihQris).toLocaleString("id-ID")}`;

            const statusKeseluruhan = selisihKeseluruhan < 0
                ? `Kurang Rp ${Math.abs(selisihKeseluruhan).toLocaleString("id-ID")}`
                : `Lebih Rp ${Math.abs(selisihKeseluruhan).toLocaleString("id-ID")}`;

            await message.reply(
                `❌ SETORAN GA PAS ${nama}
📅 Tanggal : ${tanggalLaporan}
🕐 Shift   : ${shift}
━━━━━━━━━━━━━━━━━━
✅ Liter : ${Number(dbData.total_liter).toFixed(2)} L
❌ Laporan  : ${totalLiter.toFixed(2)} L
📌 Status   : ${selisihLiter === 0 ? "Sesuai" : statusLiter}
━━━━━━━━━━━━━━━━━━
💰 Total Seluruh
✅ Harusnya : Rp ${Number(dbData.total_setoran).toLocaleString("id-ID")}
❌ Laporan  : Rp ${totalUang.toLocaleString("id-ID")}
━━━━━━━━━━━━━━━━━━
📱 QRIS
✅ Harusnya : Rp ${Number(dbData.qris).toLocaleString("id-ID")}
❌ Laporan  : Rp ${qris.toLocaleString("id-ID")}
📌 Status   : ${selisihQris === 0 ? "Sesuai" : statusQris}
━━━━━━━━━━━━━━━━━━
💵 Cash
✅ Harusnya : Rp ${Number(dbData.cash).toLocaleString("id-ID")}
❌ Laporan  : Rp ${cash.toLocaleString("id-ID")}
📌 Status   : ${selisihCash === 0 ? "Sesuai" : statusCash}
━━━━━━━━━━━━━━━━━━
🏦 Keseluruhan
✅ Harusnya : Rp ${Number(dbData.total_keseluruhan).toLocaleString("id-ID")}
❌ Laporan  : Rp ${keseluruhan.toLocaleString("id-ID")}
📌 Status   : ${selisihKeseluruhan === 0 ? "Sesuai" : statusKeseluruhan}

TATA CARA TAHAPAN LAPORAN CLOSING :
*PASTIKAN BERURUTAN!*
1. FOTO LAYAR CLOSING, SOUNDING DAN STOK DRIGEN (TULIS BERAPA DRIGEN)
2. ISI LAPORAN DI LINK SAMPAI SELESAI 
   PERHATIKAN SHIFTNYA JANGAN SAMPAI SALAH DI https://apps.tekrabyte.id/pom/
3. COPY KE CLIPBOARD DAN KIRIM KE GRUP WHATSAPP
4. SESUAIKAN CASH DAN QRIS DENGAN LAPORAN YANG VALID
*JANGAN PERNAH EDIT LAPORAN LEWAT WHATSAPP CHAT*
*NB: KALAU SELISIH Rp.1 - Rp.100 TYPO Boleh Ketik Manual*
`,
            );
        }
    } catch (err) {
        console.log("[ERROR]", err?.message || err);
        console.log(err?.stack || "");
        pushLog("error", "Error saat memproses laporan: " + (err?.message || err));
        try { await message.reply("⚠️ Format laporan / error"); } catch(e) { console.log("[REPLY GAGAL]", e?.message); }
    }
});

// ================= GLOBAL ERROR HANDLER =================
process.on("uncaughtException", (err) => {
    console.log("[UNCAUGHT EXCEPTION]", err?.message || err);
    console.log(err?.stack || "");
    state.status = "disconnected";
});

process.on("unhandledRejection", (reason) => {
    console.log("[UNHANDLED REJECTION]", reason?.message || reason);
});

// ================= START =================
(async () => {
    try {
        await client.initialize();
    } catch (err) {
        console.log("[INIT ERROR] Gagal inisialisasi WhatsApp client:", err?.message || err);
        state.status = "disconnected";
    }
})();
