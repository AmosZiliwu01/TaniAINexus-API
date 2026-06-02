import { Router } from "express";
import { createClient } from "@supabase/supabase-js";
import {
  generatePairingCode,
  unlinkWhatsapp,
} from "./db.service.js";

const router = Router();

async function getAuthUser(req) {
  const authHeader = req.headers.authorization ?? "";
  const token = authHeader.replace("Bearer ", "").trim();

  if (!token) return null;

  // Gunakan anon client untuk verifikasi JWT (bukan service_role)
  const anonClient = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  );

  const { data: { user }, error } = await anonClient.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

// POST /api/pairing/generate
router.post("/generate", async (req, res) => {
  try {
    const user = await getAuthUser(req);
    if (!user) {
      return res.status(401).json({ success: false, message: "Tidak terautentikasi" });
    }

    const code = await generatePairingCode(user.id);
    if (!code) {
      return res.status(500).json({ success: false, message: "Gagal generate kode" });
    }

    console.log(`[Pairing] Kode dibuat: ${code} untuk user: ${user.id}`);

    return res.json({
      success: true,
      code,
      expiresInMinutes: 5,
      instruction: `Kirim pesan ini ke WhatsApp bot TaniAI:\n\nLINK ${code}`,
    });
  } catch (e) {
    console.error("[Pairing] /generate error:", e.message);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// GET /api/pairing/status
router.get("/status", async (req, res) => {
  try {
    const user = await getAuthUser(req);
    if (!user) {
      return res.status(401).json({ success: false, message: "Tidak terautentikasi" });
    }

    // Gunakan service_role untuk baca whatsapp_links (bypass RLS)
    const serviceDb = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } }
    );

    const { data } = await serviceDb
      .from("whatsapp_links")
      .select("phone_number, is_verified, linked_at")
      .eq("user_id", user.id)
      .single();

    if (!data || !data.is_verified) {
      return res.json({ success: true, linked: false });
    }

    const phone  = data.phone_number.replace("@s.whatsapp.net", "");
    const masked = phone.slice(0, 5) + "***" + phone.slice(-3);

    return res.json({
      success: true,
      linked: true,
      phoneNumber: masked,
      linkedAt: data.linked_at,
    });
  } catch (e) {
    console.error("[Pairing] /status error:", e.message);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

// POST /api/pairing/unlink
router.post("/unlink", async (req, res) => {
  try {
    const user = await getAuthUser(req);
    if (!user) {
      return res.status(401).json({ success: false, message: "Tidak terautentikasi" });
    }

    const ok = await unlinkWhatsapp(user.id);
    if (!ok) {
      return res.status(500).json({ success: false, message: "Gagal unlink WhatsApp" });
    }

    return res.json({ success: true, message: "WhatsApp berhasil diputuskan dari akun." });
  } catch (e) {
    console.error("[Pairing] /unlink error:", e.message);
    return res.status(500).json({ success: false, message: "Server error" });
  }
});

export default router;