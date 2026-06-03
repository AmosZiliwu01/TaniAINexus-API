import "./config/env.js";
import express from "express";
import cors from "cors";
import { askAI } from "./services/ai.service.js";
import {
  getWhatsappLink,
  buildUserContext,
  saveChat,
  validatePairingCode,
  linkWhatsapp,
  checkDbConnection,
  getPendingWaNotifications,
  markNotificationSent,
  checkAndIncrementDailyLimit,
  isUserBlocked
} from "./services/db.service.js";
import pairingRouter from "./services/pairing.service.js";

const app = express();
const PORT = process.env.PORT || 8080;

// Whitelist origin untuk CORS
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:5173").split(",").map(o => o.trim());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    const isLocal = /^http:\/\/(localhost|127\.0\.0\.1|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(:\d+)?$/.test(origin);
    if (isLocal || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

app.get("/health", async (_req, res) => {
  const dbOk = await checkDbConnection();
  const pendingNotifs = await getPendingWaNotifications();
  res.json({
    status: "ok",
    service: "TaniAPI v5",
    db: dbOk ? "connected" : "unavailable",
    whatsapp_pending: pendingNotifs.length,
    timestamp: new Date().toISOString(),
  });
});

app.use("/api/pairing", pairingRouter);

// Ambil notifikasi pending untuk dikirim bot WA
app.get("/api/notifications/pending", async (req, res) => {
  try {
    const apiKey = req.headers["x-api-key"];
    if (process.env.INTERNAL_API_KEY && apiKey !== process.env.INTERNAL_API_KEY) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    const notifications = await getPendingWaNotifications();
    res.json({ success: true, notifications, timestamp: new Date().toISOString() });
  } catch (e) {
    console.error("[API] /notifications/pending error:", e.message);
    res.status(500).json({ success: false, notifications: [] });
  }
});

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

// Handler utama chat: pairing, cek link WA, rate limit, lalu tanya AI
app.post("/api/chat", async (req, res) => {
  try {
    const { text = "", imageBase64 = null, phoneNumber = null } = req.body;
    const hasText = typeof text === "string" && text.trim().length > 0;
    const hasImage = typeof imageBase64 === "string" && imageBase64.startsWith("data:");
    const rawText = text.trim();

    if (!hasText && !hasImage) {
      return res.status(400).json({ success: false, message: "Harus ada text atau imageBase64" });
    }
    if (!phoneNumber) {
      return res.status(400).json({ success: false, message: "phoneNumber wajib ada" });
    }

    console.log(`[API] Chat dari: ${phoneNumber} | text: "${rawText.substring(0, 60)}"`);

    const linkMatch = rawText.match(/^LINK\s+(TANI-\d{6})$/i);
    if (linkMatch) {
      const userId = await validatePairingCode(linkMatch[1]);
      if (!userId) {
        return res.json({
          success: true,
          reply: "❌ Kode tidak valid atau sudah kedaluwarsa.\n\nSilakan generate kode baru di *https://tani-ai-nexus.vercel.app → Profil → Hubungkan WhatsApp*.",
        });
      }

      const result = await linkWhatsapp(userId, phoneNumber);
      if (!result.success) {
        return res.json({ success: true, reply: `❌ ${result.message}\n\nJika masalah berlanjut, hubungi support TaniAI.` });
      }

      const ctx = await buildUserContext(userId);
      const name = ctx?.profile?.full_name || "Petani";
      return res.json({
        success: true,
        reply: `✅ Berhasil! WhatsApp kamu sudah terhubung ke akun *${name}* di *TaniAI Nexus*.\n\n🌾 Sekarang kamu bisa tanya masalah tanaman atau kirim foto untuk diagnosa!\n\n📊 *Info penggunaan:*\n• Batas pesan: *15 pesan per hari*\n• Reset setiap hari pukul 00.00 WIB\n\nCoba tanya: _"Tanaman saya kenapa daunnya kuning?"_`,
      });
    }

    const waLink = await getWhatsappLink(phoneNumber);
    if (!waLink) {
      return res.json({
        success: true,
        reply: "👋 Halo! Saya TaniAINexus.\n\nUntuk menggunakan layanan ini, kamu perlu menghubungkan WhatsApp ke akun TaniAINexus:\n\n1️⃣ Buka *https://tani-ai-nexus.vercel.app/* kemudian register atau login\n2️⃣ Masuk ke menu *Profil → Hubungkan WhatsApp*\n3️⃣ Salin kode yang muncul (contoh: TANI-483921)\n4️⃣ Kirim pesan: *LINK TANI-483921* ke sini\n\nSetelah terhubung, kamu bisa tanya apa saja seputar pertanian! 🌾",
      });
    }

    const blocked = await isUserBlocked(waLink.user_id);
    if (blocked) {
      return res.json({
        success: true,
        reply: "🚫 *Akun Anda Diblokir*\n\nAkun Anda tidak dapat menggunakan layanan ini karena telah diblokir oleh admin *TaniAI Nexus*.\n\nJika Anda merasa ini adalah kesalahan, silakan hubungi administrator.",
      });
    }

    const userContext = await buildUserContext(waLink.user_id);
    if (!userContext) {
      return res.json({
        success: true,
        reply: "Maaf, ada masalah mengambil data akunmu. Coba lagi ya! 🌾",
      });
    }

    const limitCheck = await checkAndIncrementDailyLimit(waLink.user_id);
    if (!limitCheck.allowed) {
      console.log(`[API] Rate limit hit untuk user ${waLink.user_id}: ${limitCheck.count}/${limitCheck.limit}`);
      return res.json({ success: true, reply: limitCheck.resetMessage });
    }

    const reply = await askAI({
      text: rawText,
      imageBase64: hasImage ? imageBase64 : null,
      userContext,
      isLinked: true,
    });

    await saveChat({
      userId: waLink.user_id,
      message: hasText ? rawText : "[gambar]",
      response: reply,
      hasImage,
    });

    return res.json({ success: true, reply });
  } catch (e) {
    console.error("[API] /api/chat unhandled:", e.message);
    return res.status(500).json({
      success: false,
      reply: "Maaf, terjadi kesalahan. Coba lagi! 🌾",
    });
  }
});

app.use((_req, res) => res.status(404).json({ success: false, error: "Not Found" }));
app.use((err, _req, res, _next) => {
  console.error("[API] Express error:", err.message);
  res.status(500).json({ success: false, error: "Internal Server Error" });
});

app.listen(PORT, async () => {
  console.log(`\n🚀 TaniAPI v5 berjalan di port ${PORT}`);
  console.log(`📡 POST http://localhost:${PORT}/api/chat`);
  console.log(`🔔 GET  http://localhost:${PORT}/api/notifications/pending`);
  console.log(`🔗 POST http://localhost:${PORT}/api/pairing/generate`);
  console.log(`❤️  GET  http://localhost:${PORT}/health\n`);
  const dbOk = await checkDbConnection();
  console.log(dbOk ? "✅ Supabase: connected" : "⚠️  Supabase: unavailable — cek .env");
});