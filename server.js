/**
 * server.js — TaniAPI Express Server v4.0
 *
 * PERUBAHAN dari v3:
 * ✅ NEW: GET  /api/notifications/pending    — WA bot polling notifikasi
 * ✅ NEW: POST /api/notifications/mark-sent  — tandai notif sudah terkirim ke WA
 * ✅ NEW: POST /api/notify/push              — trigger manual (dari web / cron)
 */

// ── Load env PERTAMA ──────────────────────────────────────────
import "./config/env.js";

import express from "express";
import cors    from "cors";

import { askAI }                    from "./services/ai.service.js";
import {
  getWhatsappLink,
  buildUserContext,
  saveChat,
  validatePairingCode,
  linkWhatsapp,
  checkDbConnection,
  getPendingWaNotifications,
  markNotificationSent,
}                                   from "./services/db.service.js";
import pairingRouter                from "./services/pairing.service.js";

const app  = express();
const PORT = process.env.PORT || 3000;

// ──────────────────────────────────────────────
// MIDDLEWARE
// ──────────────────────────────────────────────

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:5173").split(",");
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
      cb(new Error(`CORS blocked: ${origin}`));
    },
    credentials: true,
  })
);
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ──────────────────────────────────────────────
// HEALTH CHECK
// ──────────────────────────────────────────────

app.get("/health", async (_req, res) => {
  const dbOk = await checkDbConnection();
  res.json({
    status:    "ok",
    service:   "TaniAPI v4",
    db:        dbOk ? "connected" : "unavailable",
    timestamp: new Date().toISOString(),
  });
});

// ──────────────────────────────────────────────
// PAIRING ROUTES
// ──────────────────────────────────────────────

app.use("/api/pairing", pairingRouter);

// ══════════════════════════════════════════════
// NOTIFICATION ROUTES (baru)
// ══════════════════════════════════════════════

/**
 * GET /api/notifications/pending
 * Dipanggil oleh WA bot setiap 30 detik.
 * Mengembalikan daftar notifikasi yang belum dikirim ke WA.
 *
 * Response:
 * {
 *   notifications: [
 *     { id, phone_number, title, message }
 *   ]
 * }
 */
app.get("/api/notifications/pending", async (_req, res) => {
  try {
    const notifications = await getPendingWaNotifications();
    res.json({ success: true, notifications });
  } catch (e) {
    console.error("[API] /notifications/pending error:", e.message);
    res.status(500).json({ success: false, notifications: [] });
  }
});

/**
 * POST /api/notifications/mark-sent
 * Dipanggil WA bot setelah berhasil kirim pesan.
 * Body: { id: "uuid" }
 */
app.post("/api/notifications/mark-sent", async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, message: "id wajib ada" });
    await markNotificationSent(id);
    res.json({ success: true });
  } catch (e) {
    console.error("[API] /notifications/mark-sent error:", e.message);
    res.status(500).json({ success: false });
  }
});

/**
 * POST /api/notify/push
 * Endpoint trigger manual dari web / Supabase DB trigger / cron.
 * Gunakan untuk kirim notifikasi ad-hoc ke user tertentu.
 *
 * Body: { user_id, title, body, type }
 * type: "diagnosis" | "community" | "info" | "market"
 */
app.post("/api/notify/push", async (req, res) => {
  try {
    const { user_id, title, body, type = "info" } = req.body;
    if (!user_id || !title) {
      return res.status(400).json({ success: false, message: "user_id dan title wajib ada" });
    }

    const { createNotification } = await import("./services/db.service.js");
    const result = await createNotification({ user_id, title, body, type });

    if (!result) return res.status(500).json({ success: false, message: "Gagal buat notifikasi" });
    res.json({ success: true, notification: result });
  } catch (e) {
    console.error("[API] /notify/push error:", e.message);
    res.status(500).json({ success: false });
  }
});

// ──────────────────────────────────────────────
// POST /api/chat
// ──────────────────────────────────────────────

app.post("/api/chat", async (req, res) => {
  try {
    const { text = "", imageBase64 = null, phoneNumber = null } = req.body;

    const hasText  = typeof text === "string" && text.trim().length > 0;
    const hasImage = typeof imageBase64 === "string" && imageBase64.startsWith("data:");
    const rawText  = text.trim();

    if (!hasText && !hasImage) {
      return res.status(400).json({ success: false, message: "Harus ada text atau imageBase64" });
    }
    if (!phoneNumber) {
      return res.status(400).json({ success: false, message: "phoneNumber wajib ada" });
    }

    console.log(`[API] Chat dari: ${phoneNumber} | text: "${rawText.substring(0, 60)}"`);

    // Perintah LINK
    const linkMatch = rawText.match(/^LINK\s+(TANI-\d{6})$/i);
    if (linkMatch) return await handleLinkCommand(linkMatch[1], phoneNumber, res);

    const waLink = await getWhatsappLink(phoneNumber);

    if (!waLink) {
      return res.json({
        success: true,
        reply:
          "👋 Halo! Saya TaniAINexus.\n\n" +
          "Untuk menggunakan layanan ini, kamu perlu menghubungkan WhatsApp ke akun TaniAINexus:\n\n" +
          "1️⃣ Buka *taniainexus.com* kemudian register atau login\n" +
          "2️⃣ Masuk ke menu *Profil → Hubungkan WhatsApp*\n" +
          "3️⃣ Salin kode yang muncul (contoh: TANI-483921)\n" +
          "4️⃣ Kirim pesan: *LINK TANI-483921* ke sini\n\n" +
          "Setelah terhubung, kamu bisa tanya apa saja seputar pertanian! 🌾",
      });
    }

    const userContext = await buildUserContext(waLink.user_id);
    if (!userContext) {
      return res.json({
        success: true,
        reply: "Maaf, ada masalah mengambil data akunmu. Coba lagi ya! 🌾",
      });
    }

    const reply = await askAI({
      text:        rawText,
      imageBase64: hasImage ? imageBase64 : null,
      userContext,
      isLinked:    true,
    });

    saveChat({
      userId:   waLink.user_id,
      message:  hasText ? rawText : "[gambar]",
      response: reply,
      hasImage,
    }).catch((e) => console.error("[API] saveChat error:", e.message));

    return res.json({ success: true, reply });
  } catch (e) {
    console.error("[API] /api/chat unhandled:", e.message);
    return res.status(500).json({
      success: false,
      reply:   "Maaf, terjadi kesalahan. Coba lagi! 🌾",
    });
  }
});

// ──────────────────────────────────────────────
// HANDLER: LINK command
// ──────────────────────────────────────────────

async function handleLinkCommand(code, phoneNumber, res) {
  console.log(`[API] LINK command: ${code} dari ${phoneNumber}`);
  const userId = await validatePairingCode(code);

  if (!userId) {
    return res.json({
      success: true,
      reply:
        "❌ Kode tidak valid atau sudah kedaluwarsa.\n\n" +
        "Silakan generate kode baru di *taniainexus.com → Profil → Hubungkan WhatsApp*.",
    });
  }

  const result = await linkWhatsapp(userId, phoneNumber);
  if (!result.success) {
    return res.json({
      success: true,
      reply: `❌ ${result.message}\n\nJika masalah berlanjut, hubungi support TaniAI.`,
    });
  }

  const ctx  = await buildUserContext(userId);
  const name = ctx?.profile?.full_name || "Petani";

  return res.json({
    success: true,
    reply:
      `✅ Berhasil! WhatsApp kamu sudah terhubung ke akun *${name}* di *TaniAI Nexus*.\n\n` +
      `Sekarang kamu bisa langsung tanya masalah tanaman, kirim foto untuk diagnosa! 🌾\n\n` +
      `Coba tanya sekarang: _"Tanaman saya kenapa daunnya kuning?"_`,
  });
}

// ──────────────────────────────────────────────
// 404 & ERROR HANDLER
// ──────────────────────────────────────────────

app.use((_req, res) => res.status(404).json({ success: false, error: "Not Found" }));
app.use((err, _req, res, _next) => {
  console.error("[API] Express error:", err.message);
  res.status(500).json({ success: false, error: "Internal Server Error" });
});

// ──────────────────────────────────────────────
// START
// ──────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`\n🚀 TaniAPI v4 berjalan di port ${PORT}`);
  console.log(`📡 POST http://localhost:${PORT}/api/chat`);
  console.log(`🔔 GET  http://localhost:${PORT}/api/notifications/pending`);
  console.log(`🔗 POST http://localhost:${PORT}/api/pairing/generate`);
  console.log(`❤️  GET  http://localhost:${PORT}/health\n`);

  const dbOk = await checkDbConnection();
  console.log(dbOk ? "✅ Supabase: connected" : "⚠️  Supabase: unavailable — cek .env");
});