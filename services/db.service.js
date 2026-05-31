// db.service.js v2 — tambah fungsi notifikasi WA push
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

let _client = null;
function db() {
  if (!_client) {
    _client = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
  }
  return _client;
}

function log(fn, msg, extra = "") { console.log(`[DB:${fn}] ${msg}`, extra); }
function err(fn, msg, e)          { console.error(`[DB:${fn}] ❌ ${msg}:`, e?.message ?? e); }

// ──────────────────────────────────────────────────────────────
// EXISTING FUNCTIONS (tidak diubah)
// ──────────────────────────────────────────────────────────────

export async function generatePairingCode(userId) {
  try {
    await db().from("pairing_codes").delete().eq("user_id", userId).eq("used", false);
    const digits = crypto.randomInt(100000, 999999).toString();
    const code   = `TANI-${digits}`;
    const { error } = await db().from("pairing_codes").insert({
      user_id:    userId,
      code,
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });
    if (error) throw error;
    log("generatePairingCode", `Kode untuk user ${userId}: ${code}`);
    return code;
  } catch (e) { err("generatePairingCode", "Gagal", e); return null; }
}

export async function validatePairingCode(code) {
  try {
    const { data, error } = await db()
      .from("pairing_codes")
      .select("id, user_id, expires_at, used")
      .eq("code", code.toUpperCase())
      .single();
    if (error || !data)           { log("validatePairingCode", `Tidak ditemukan: ${code}`); return null; }
    if (data.used)                { log("validatePairingCode", `Sudah dipakai: ${code}`);   return null; }
    if (new Date(data.expires_at) < new Date()) { log("validatePairingCode", `Expired: ${code}`); return null; }
    await db().from("pairing_codes").update({ used: true }).eq("id", data.id);
    log("validatePairingCode", `Valid untuk user: ${data.user_id}`);
    return data.user_id;
  } catch (e) { err("validatePairingCode", "Error", e); return null; }
}

export async function getWhatsappLink(phoneNumber) {
  try {
    const { data, error } = await db()
      .from("whatsapp_links")
      .select("user_id, is_verified")
      .eq("phone_number", phoneNumber)
      .eq("is_verified", true)
      .single();
    if (error || !data) return null;
    return data;
  } catch (e) { err("getWhatsappLink", "Error", e); return null; }
}

export async function linkWhatsapp(userId, phoneNumber) {
  try {
    const { data: existing } = await db()
      .from("whatsapp_links")
      .select("user_id")
      .eq("phone_number", phoneNumber)
      .neq("user_id", userId)
      .single();
    if (existing) return { success: false, message: "Nomor WhatsApp sudah terhubung ke akun lain." };
    const { error } = await db().from("whatsapp_links").upsert(
      { user_id: userId, phone_number: phoneNumber, is_verified: true, linked_at: new Date().toISOString() },
      { onConflict: "user_id" }
    );
    if (error) throw error;
    log("linkWhatsapp", `User ${userId} link WA: ${phoneNumber}`);
    return { success: true, message: "WhatsApp berhasil dihubungkan!" };
  } catch (e) { err("linkWhatsapp", "Error", e); return { success: false, message: "Gagal menghubungkan WhatsApp." }; }
}

export async function unlinkWhatsapp(userId) {
  try {
    const { error } = await db().from("whatsapp_links").delete().eq("user_id", userId);
    if (error) throw error;
    log("unlinkWhatsapp", `User ${userId} unlink WA`);
    return true;
  } catch (e) { err("unlinkWhatsapp", "Error", e); return false; }
}

export async function buildUserContext(userId) {
  try {
    const [profileRes, plantsRes, diagnosesRes, historyRes, communityRes, articlesRes] = await Promise.all([
      db().from("profiles").select("full_name, location, farmer_type, bio, phone").eq("id", userId).single(),
      db().from("user_plants").select("name, status, type").eq("user_id", userId).order("created_at", { ascending: false }).limit(20),
      db().from("plant_diagnoses").select("plant_type, diagnosis, severity, created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(5),
      db().from("whatsapp_chats").select("message, response, created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(6),
      db().from("community_posts").select("title, category, likes_count, comments_count, created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(3),
      db().from("articles").select("title, slug, excerpt, content, category, published, created_at").eq("published", true).order("created_at", { ascending: false }).limit(5),
    ]);

    const profile       = profileRes.data  ?? {};
    const plants        = plantsRes.data   ?? [];
    const diagnoses     = diagnosesRes.data ?? [];
    const chatHistory   = (historyRes.data ?? []).reverse();
    const communityPosts= communityRes.data ?? [];
    const articles      = articlesRes.data  ?? [];

    log("buildUserContext", `User ${profile.full_name || userId}`,
        `plants:${plants.length} diag:${diagnoses.length} posts:${communityPosts.length}`);

    return { userId, profile, plants, diagnoses, chatHistory, communityPosts, articles };
  } catch (e) { err("buildUserContext", "Error", e); return null; }
}

export async function saveChat({ userId, message, response, hasImage = false }) {
  try {
    const { error } = await db().from("whatsapp_chats").insert({
      user_id: userId, message, response, has_image: hasImage,
    });
    if (error) throw error;
    log("saveChat", `Saved for user ${userId}`);
  } catch (e) { err("saveChat", "Gagal", e); }
}

export async function checkDbConnection() {
  try {
    const { error } = await db().from("whatsapp_links").select("id").limit(1);
    return !error;
  } catch { return false; }
}

export async function getLatestArticles(limit = 5) {
  try {
    const { data, error } = await db()
      .from("articles")
      .select("title, slug, excerpt, content, published, created_at, category")
      .eq("published", true)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  } catch (e) { err("getLatestArticles", "Gagal", e); return []; }
}

// ══════════════════════════════════════════════════════════════
// FUNGSI BARU — NOTIFIKASI WA PUSH
// ══════════════════════════════════════════════════════════════

/**
 * Format pesan WA berdasarkan tipe notifikasi.
 * Menghasilkan teks yang ramah untuk dibaca di WhatsApp.
 */
function formatWaMessage(notif) {
  const emoji = {
    diagnosis:  "🔬",
    community:  "💬",
    market:     "📈",
    info:       "📢",
    warning:    "⚠️",
  }[notif.type] || "🔔";

  return (
    `${emoji} *${notif.title}*\n\n` +
    `${notif.body || ""}\n\n` +
    `_Buka TaniAI Nexus untuk detail selengkapnya._`
  ).trim();
}

/**
 * Ambil notifikasi yang belum dikirim ke WhatsApp.
 *
 * Cara kerja:
 * - Join tabel notifications + whatsapp_links
 *   untuk dapat nomor HP user.
 * - Filter: is_read = false AND wa_sent = false
 *   (kolom wa_sent ditambahkan via SQL migration di bawah)
 *
 * Return: array { id, phone_number, title, message }
 */
export async function getPendingWaNotifications() {
  try {
    // Ambil notifikasi pending
    const { data: notifs, error } = await db()
      .from("notifications")
      .select("id, user_id, title, body, type, created_at")
      .eq("is_read", false)
      .eq("wa_sent", false)          // kolom baru — lihat migration
      .order("created_at", { ascending: true })
      .limit(20);                    // maks 20 per poll

    if (error) throw error;
    if (!notifs?.length) return [];

    // Untuk setiap notifikasi, ambil nomor HP user
    const results = [];
    for (const notif of notifs) {
      const { data: link } = await db()
        .from("whatsapp_links")
        .select("phone_number")
        .eq("user_id", notif.user_id)
        .eq("is_verified", true)
        .single();

      if (!link?.phone_number) {
        // User tidak punya WA terhubung — tandai agar tidak di-poll terus
        await db().from("notifications").update({ wa_sent: true }).eq("id", notif.id);
        continue;
      }

      results.push({
        id:           notif.id,
        phone_number: link.phone_number,
        title:        notif.title,
        message:      formatWaMessage(notif),
      });
    }

    log("getPendingWaNotifications", `${results.length} notif siap dikirim WA`);
    return results;
  } catch (e) { err("getPendingWaNotifications", "Error", e); return []; }
}

/**
 * Tandai notifikasi sudah dikirim ke WA.
 * Dipanggil setelah WA bot berhasil kirim pesan.
 */
export async function markNotificationSent(notifId) {
  try {
    const { error } = await db()
      .from("notifications")
      .update({ wa_sent: true, is_read: true })
      .eq("id", notifId);
    if (error) throw error;
    log("markNotificationSent", `Notif ${notifId} ditandai terkirim`);
  } catch (e) { err("markNotificationSent", "Error", e); }
}

/**
 * Buat notifikasi baru untuk user (dari server/admin/trigger).
 * Type: "diagnosis" | "community" | "market" | "info" | "warning"
 */
export async function createNotification({ user_id, title, body, type = "info" }) {
  try {
    const { data, error } = await db()
      .from("notifications")
      .insert({ user_id, title, body, type, wa_sent: false, is_read: false })
      .select()
      .single();
    if (error) throw error;
    log("createNotification", `Buat notif untuk user ${user_id}: ${title}`);
    return data;
  } catch (e) { err("createNotification", "Error", e); return null; }
}