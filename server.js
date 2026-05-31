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
} from "./services/db.service.js";

import pairingRouter from "./services/pairing.service.js";

const app = express();

const PORT = process.env.PORT || 8080;

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

app.get("/health", async (_req, res) => {
  const dbOk = await checkDbConnection();
  res.json({
    status: "ok",
    service: "TaniAPI v4",
    db: dbOk ? "connected" : "unavailable",
    timestamp: new Date().toISOString(),
  });
});

app.use("/api/pairing", pairingRouter);

app.get("/api/notifications/pending", async (_req, res) => {
  try {
    const notifications = await getPendingWaNotifications();
    res.json({ success: true, notifications });
  } catch (e) {
    res.status(500).json({ success: false, notifications: [] });
  }
});

app.post("/api/notifications/mark-sent", async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false });
    await markNotificationSent(id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false });
  }
});

app.post("/api/notify/push", async (req, res) => {
  try {
    const { user_id, title, body, type = "info" } = req.body;
    if (!user_id || !title) {
      return res.status(400).json({ success: false });
    }

    const { createNotification } = await import("./services/db.service.js");
    const result = await createNotification({ user_id, title, body, type });

    if (!result) return res.status(500).json({ success: false });

    res.json({ success: true, notification: result });
  } catch (e) {
    res.status(500).json({ success: false });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const { text = "", imageBase64 = null, phoneNumber = null } = req.body;

    const hasText = typeof text === "string" && text.trim().length > 0;
    const hasImage = typeof imageBase64 === "string" && imageBase64.startsWith("data:");
    const rawText = text.trim();

    if (!hasText && !hasImage) {
      return res.status(400).json({ success: false });
    }

    if (!phoneNumber) {
      return res.status(400).json({ success: false });
    }

    const linkMatch = rawText.match(/^LINK\s+(TANI-\d{6})$/i);
    if (linkMatch) return await handleLinkCommand(linkMatch[1], phoneNumber, res);

    const waLink = await getWhatsappLink(phoneNumber);

    if (!waLink) {
      return res.json({
        success: true,
        reply: "Silakan link akun dulu di TaniAI Nexus",
      });
    }

    const userContext = await buildUserContext(waLink.user_id);

    const reply = await askAI({
      text: rawText,
      imageBase64: hasImage ? imageBase64 : null,
      userContext,
      isLinked: true,
    });

    saveChat({
      userId: waLink.user_id,
      message: hasText ? rawText : "[gambar]",
      response: reply,
      hasImage,
    }).catch(() => {});

    return res.json({ success: true, reply });
  } catch (e) {
    return res.status(500).json({ success: false });
  }
});

async function handleLinkCommand(code, phoneNumber, res) {
  const userId = await validatePairingCode(code);

  if (!userId) {
    return res.json({ success: true, reply: "Kode invalid" });
  }

  const result = await linkWhatsapp(userId, phoneNumber);

  if (!result.success) {
    return res.json({ success: true, reply: result.message });
  }

  const ctx = await buildUserContext(userId);

  return res.json({
    success: true,
    reply: `Berhasil connect ${ctx?.profile?.full_name || "User"}`,
  });
}

app.use((_req, res) => res.status(404).json({ success: false }));

app.use((err, _req, res, _next) => {
  res.status(500).json({ success: false });
});

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`🚀 API running on port ${PORT}`);
  const dbOk = await checkDbConnection();
  console.log(dbOk ? "DB OK" : "DB FAIL");
});