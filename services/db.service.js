// db.service.js v2 — dengan normalisasi nomor WhatsApp + notifikasi WA push
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
// NORMALISASI NOMOR WA (hilangkan @s.whatsapp.net)
// ──────────────────────────────────────────────────────────────
function normalizePhoneNumber(phoneNumber) {
  if (!phoneNumber) return phoneNumber;
  return phoneNumber.replace(/@s\.whatsapp\.net$/, '').trim();
}

// ──────────────────────────────────────────────────────────────
// PAIRING
// ──────────────────────────────────────────────────────────────
export async function generatePairingCode(userId) {
  try {
    await db().from("pairing_codes").delete().eq("user_id", userId).eq("used", false);
    const digits = crypto.randomInt(100000, 999999).toString();
    const code   = `TANI-${digits}`;
    const { error } = await db().from("pairing_codes").insert({
      user_id: userId,
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
    const normalized = normalizePhoneNumber(phoneNumber);
    const { data, error } = await db()
      .from("whatsapp_links")
      .select("user_id, is_verified")
      .eq("phone_number", normalized)
      .eq("is_verified", true)
      .single();
    if (error || !data) return null;
    return data;
  } catch (e) { err("getWhatsappLink", "Error", e); return null; }
}

export async function linkWhatsapp(userId, phoneNumber) {
  try {
    const normalized = normalizePhoneNumber(phoneNumber);
    const { data: existing } = await db()
      .from("whatsapp_links")
      .select("user_id")
      .eq("phone_number", normalized)
      .neq("user_id", userId)
      .single();
    if (existing) return { success: false, message: "Nomor WhatsApp sudah terhubung ke akun lain." };
    const { error } = await db().from("whatsapp_links").upsert(
      { user_id: userId, phone_number: normalized, is_verified: true, linked_at: new Date().toISOString() },
      { onConflict: "user_id" }
    );
    if (error) throw error;
    log("linkWhatsapp", `User ${userId} link WA: ${normalized}`);
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

// ──────────────────────────────────────────────────────────────
// USER CONTEXT & CHAT
// ──────────────────────────────────────────────────────────────
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

    log("buildUserContext", `User ${profile.full_name || userId}`, `plants:${plants.length} diag:${diagnoses.length} posts:${communityPosts.length}`);
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
// ──────────────────────────────────────────────────────────────
// RATE LIMIT: 15 pesan WA per user per hari (reset jam 00.00)
// ──────────────────────────────────────────────────────────────
export async function checkAndIncrementDailyLimit(userId) {
  try {
    // Batas awal dan akhir hari ini (UTC+7 / WIB)
    const now = new Date();
    // Hitung awal hari di WIB (UTC+7): kurangi offset, ambil floor hari, tambah offset
    const wibOffset = 7 * 60 * 60 * 1000;
    const todayWibStart = new Date(Math.floor((now.getTime() + wibOffset) / 86400000) * 86400000 - wibOffset);
    const todayWibEnd   = new Date(todayWibStart.getTime() + 86400000);

    // Hitung pesan hari ini
    const { count, error } = await db()
      .from("whatsapp_chats")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("created_at", todayWibStart.toISOString())
      .lt("created_at", todayWibEnd.toISOString());

    if (error) throw error;

    const dailyCount = count ?? 0;
    const DAILY_LIMIT = 15;

    log("checkDailyLimit", `User ${userId}: ${dailyCount}/${DAILY_LIMIT} pesan hari ini`);

    if (dailyCount >= DAILY_LIMIT) {
      // Hitung jam reset berikutnya (00.00 WIB besok)
      const resetTime = todayWibEnd;
      const hoursLeft = Math.ceil((resetTime.getTime() - now.getTime()) / 3600000);
      return {
        allowed: false,
        count: dailyCount,
        limit: DAILY_LIMIT,
        resetMessage:
          `⏳ Batas pesan harian kamu sudah tercapai (${DAILY_LIMIT} pesan/hari).\n\n` +
          `Kuota akan direset dalam *${hoursLeft} jam* pada pukul *00.00 WIB*.\n\n` +
          `Untuk kebutuhan mendesak, gunakan fitur AI di *https://tani-ai-nexus.vercel.app* 🌾`,
      };
    }

    return { allowed: true, count: dailyCount, limit: DAILY_LIMIT };
  } catch (e) {
    err("checkDailyLimit", "Error", e);
    // Jika error cek limit, izinkan pesan (fail open)
    return { allowed: true, count: 0, limit: 15 };
  }
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
// NOTIFIKASI WA PUSH
// ══════════════════════════════════════════════════════════════
function formatWaMessage(notif) {
  const emoji = {
    diagnosis:  "🔬",
    community:  "💬",
    market:     "📈",
    info:       "📢",
    warning:    "⚠️",
  }[notif.type] || "🔔";
  return `${emoji} *${notif.title}*\n\n${notif.body || ""}\n\n_Buka TaniAI Nexus untuk detail selengkapnya._ `.trim();
}

export async function getPendingWaNotifications() {
  try {
    const { data: notifs, error } = await db()
      .from("notifications")
      .select("id, user_id, title, body, type, created_at")
      .eq("is_read", false)
      .eq("wa_sent", false)
      .order("created_at", { ascending: true })
      .limit(20);
    if (error) throw error;
    if (!notifs?.length) return [];

    const results = [];
    for (const notif of notifs) {
      const { data: link } = await db()
        .from("whatsapp_links")
        .select("phone_number")
        .eq("user_id", notif.user_id)
        .eq("is_verified", true)
        .single();

      if (!link?.phone_number) {
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