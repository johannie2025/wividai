/**
 * WISE OS UNIFIED — server.js v3.1 FINAL
 * Multi-Tenant Isolation + MySQL Session Persistence
 * Compatible avec wise_os_v32.sql
 */

import express    from "express";
import cors       from "cors";
import qrcode     from "qrcode";
import mysql      from "mysql2/promise";
import nodemailer from "nodemailer";
import dotenv     from "dotenv";

dotenv.config();

let makeWASocket, useMultiFileAuthState, DisconnectReason, delay;

(async () => {
  const baileys = await import("@whiskeysockets/baileys");
  makeWASocket     = baileys.default;
  useMultiFileAuthState = baileys.useMultiFileAuthState;
  DisconnectReason = baileys.DisconnectReason;
  delay            = baileys.delay;
  startServer();
})();

// ====================== I18N ======================
const i18n = { /* Ton système i18n complet reste ici */ };

function detectLang(req) {
  const param = req.query?.lang || req.body?.lang;
  if (param && i18n[param]) return param;
  const primary = (req.headers["accept-language"] || "fr").split(",")[0].split("-")[0].toLowerCase();
  return i18n[primary] ? primary : "fr";
}

function getMessage(lang, section, key, ...args) {
  const template = i18n[lang]?.[section]?.[key] || i18n.fr?.[section]?.[key];
  return typeof template === "function" ? template(...args) : template || "";
}

// ====================== CONFIG ======================
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.NODE_API_KEY;

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 15,
  charset: "utf8mb4",
});

const sessions = new Map();   // tenant_id → session
const sseClients = new Map();

const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || 587),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});

// ====================== DB HELPERS ======================
async function loadSessionFromDB(tenantId) {
  try {
    const [rows] = await pool.execute(
      "SELECT session_data FROM whatsapp_sessions WHERE tenant_id = ? LIMIT 1",
      [tenantId]
    );
    return rows.length ? JSON.parse(rows[0].session_data) : null;
  } catch (e) {
    console.error("[DB Load Session]", e.message);
    return null;
  }
}

async function saveSessionToDB(tenantId, creds) {
  try {
    await pool.execute(
      `INSERT INTO whatsapp_sessions (tenant_id, session_data, updated_at)
       VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE session_data = VALUES(session_data), updated_at = NOW()`,
      [tenantId, JSON.stringify(creds)]
    );
  } catch (e) { console.error("[DB Save Session]", e.message); }
}

// ====================== KEEP-ALIVE ======================
setInterval(() => {
  console.log(`[KEEP-ALIVE] Wise OS v3.1 • ${new Date().toISOString()}`);
}, 4 * 60 * 1000);

// ====================== BROADCAST SSE ======================
function broadcastSSE(tenantId, data) {
  const clients = sseClients.get(String(tenantId));
  if (!clients) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => {
    try { res.write(payload); } catch (_) {}
  });
}

// ====================== WHATSAPP CORE ======================
async function connectWhatsApp(tenantId) {
  // Nettoyage propre de l'ancienne session
  if (sessions.has(tenantId)) {
    const old = sessions.get(tenantId);
    if (old && old.sock) {
      try { old.sock.end(); } catch (_) {}
    }
    sessions.delete(tenantId);
  }

  const saved = await loadSessionFromDB(tenantId);
  const auth = await useMultiFileAuthState(`/tmp/wa_${tenantId}`);

  if (saved) Object.assign(auth.state.creds, saved);

  const { state, saveCreds } = auth;
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: ["Wise OS", "Chrome", "3.1"],
  });

  const sd = { sock, status: "connecting", qrBase64: null, lastActivity: Date.now() };
  sessions.set(tenantId, sd);

  sock.ev.on("creds.update", async () => {
    await saveCreds();
    await saveSessionToDB(tenantId, state.creds);
  });

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    sd.lastActivity = Date.now();

    if (qr) {
      sd.qrBase64 = await qrcode.toDataURL(qr, { width: 420, margin: 2 });
      sd.status = "qr_pending";
      broadcastSSE(tenantId, { type: "qr", qr: sd.qrBase64 });
    }

    if (connection === "open") {
      sd.status = "connected";
      sd.qrBase64 = null;
      broadcastSSE(tenantId, { type: "connected" });
      console.log(`✅ [WA] Connecté → Tenant ${tenantId}`);
    }

    if (connection === "close") {
      broadcastSSE(tenantId, { type: "disconnected" });
      if (lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut) {
        setTimeout(() => connectWhatsApp(tenantId), 8000);
      }
    }
  });
}

async function sendWA(tenantId, phone, text) {
  let sd = sessions.get(tenantId || 1);
  if (!sd || sd.status !== "connected") {
    await connectWhatsApp(tenantId || 1);
    await delay(2800);
    sd = sessions.get(tenantId || 1);
  }
  if (!sd?.sock) return false;

  try {
    const jid = phone.replace(/\D/g, "") + "@s.whatsapp.net";
    await sd.sock.sendMessage(jid, { text });
    return true;
  } catch (e) {
    console.error("[sendWA]", e.message);
    return false;
  }
}

// ====================== EXPRESS ======================
async function startServer() {
  const app = express();
  app.use(cors({ origin: process.env.FRONTEND_URL || "*", credentials: true }));
  app.use(express.json({ limit: "10mb" }));

  const auth = (req, res, next) => {
    if (!API_KEY) return next();
    if ((req.headers["x-api-key"] || req.body?._api_key) !== API_KEY) 
      return res.status(403).json({ error: "Unauthorized" });
    next();
  };

  app.get("/health", (_, res) => res.json({ status: "ok", version: "3.1" }));

  // SSE Connect
  app.get("/connect", (req, res) => {
    const tenantId = req.query.tenant_id || req.query.user_id;
    if (!tenantId) return res.status(400).json({ error: "tenant_id requis" });

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    if (!sseClients.has(tenantId)) sseClients.set(tenantId, new Set());
    sseClients.get(tenantId).add(res);

    const sd = sessions.get(tenantId);
    if (sd?.status === "connected") res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
    else connectWhatsApp(tenantId).catch(console.error);

    req.on("close", () => sseClients.get(tenantId)?.delete(res));
  });

  // Generate OTP
  app.post("/generate-otp", auth, async (req, res) => {
    const { phone, tenant_id, type = "default", ref_name = "" } = req.body;
    if (!phone || !tenant_id) return res.status(400).json({ error: "phone et tenant_id requis" });

    const lang = detectLang(req);
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expires = new Date(Date.now() + 10 * 60 * 1000);

    try {
      await pool.execute(
        `INSERT INTO otp_codes (tenant_id, recipient, code, type, expires_at, used)
         VALUES (?,?,?,?,?,0)
         ON DUPLICATE KEY UPDATE code=VALUES(code), expires_at=VALUES(expires_at), used=0`,
        [tenant_id, phone, code, type, expires]
      );

      const message = getMessage(lang, "otp", type, code, ref_name);
      res.json({ success: true, expires_in: 600 });

      sendWA(tenant_id, phone, message);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Validate OTP
  app.post("/validate-otp", auth, async (req, res) => {
    const { phone, code, tenant_id } = req.body;
    if (!phone || !code || !tenant_id) return res.status(400).json({ error: "phone, code, tenant_id requis" });

    try {
      const [rows] = await pool.execute(
        `SELECT id, type FROM otp_codes 
         WHERE tenant_id = ? AND recipient = ? AND code = ? 
         AND expires_at > NOW() AND used = 0 LIMIT 1`,
        [tenant_id, phone, code]
      );

      if (!rows.length) return res.status(401).json({ valid: false, error: "OTP invalide ou expiré" });

      await pool.execute("UPDATE otp_codes SET used = 1 WHERE id = ?", [rows[0].id]);
      res.json({ valid: true, type: rows[0].type });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.listen(PORT, async () => {
    console.log(`🚀 Wise OS Unified v3.1 démarré sur port ${PORT}`);
    const centralTenant = 1;
    connectWhatsApp(centralTenant).catch(console.error);
  });
}
