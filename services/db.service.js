import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

// Singleton Supabase client
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

function err(fn, msg, e) { console.error(`[DB:${fn}] ❌ ${msg}:`, e?.message ?? e); }

// Bersihkan nomor telepon ke format 62xxx
function cleanNumber(raw) {
  let n = String(raw || "")
    .replace(/@s\.whatsapp\.net$|@lid$|@c\.us$/g, "")
    .replace(/[^0-9]/g, "");
  if (!n) return null;
  if (n.startsWith("0")) n = "62" + n.substring(1);
  else if (!n.startsWith("62") && n.length >= 10 && n.length <= 13) n = "62" + n;
  return n;
}

// Hitung selisih hari dari tanggal ke hari ini
function daysSince(dateStr) {
  if (!dateStr) return null;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

// Format tanggal ke format panjang bahasa Indonesia
function formatDate(dateStr) {
  if (!dateStr) return null;
  return new Date(dateStr).toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });
}

// Generate kode pairing sementara untuk user (berlaku 5 menit)
export async function generatePairingCode(userId) {
  try {
    await db().from("pairing_codes").delete().eq("user_id", userId).eq("used", false);
    const code = `TANI-${crypto.randomInt(100000, 999999)}`;
    const { error } = await db().from("pairing_codes").insert({
      user_id: userId,
      code,
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    if (error) throw error;
    return code;
  } catch (e) { err("generatePairingCode", "Gagal", e); return null; }
}

// Validasi kode pairing dan tandai sebagai terpakai
export async function validatePairingCode(code) {
  try {
    const { data, error } = await db()
      .from("pairing_codes")
      .select("id, user_id, expires_at, used")
      .eq("code", code.toUpperCase())
      .single();
    if (error || !data || data.used) return null;
    if (new Date(data.expires_at) < new Date()) return null;
    await db().from("pairing_codes").update({ used: true }).eq("id", data.id);
    return data.user_id;
  } catch (e) { err("validatePairingCode", "Error", e); return null; }
}

export async function getWhatsappLinkByPhone(phoneNumber) {
  try {
    const cleaned = cleanNumber(phoneNumber);
    if (!cleaned) return null;
    const { data, error } = await db()
      .from("whatsapp_links")
      .select("user_id, phone_number, is_verified")
      .eq("phone_number", cleaned)
      .eq("is_verified", true)
      .single();
    if (error || !data) return null;
    return data;
  } catch (e) { console.error("[DB] getWhatsappLinkByPhone error:", e); return null; }
}

export async function getWhatsappLinkByUserId(userId) {
  try {
    const { data, error } = await db()
      .from("whatsapp_links")
      .select("user_id, phone_number, is_verified")
      .eq("user_id", userId)
      .eq("is_verified", true)
      .single();
    if (error || !data) return null;
    return data;
  } catch (e) { err("getWhatsappLinkByUserId", "Error", e); return null; }
}

export { getWhatsappLinkByPhone as getWhatsappLink };

// Hubungkan nomor WhatsApp ke akun user
export async function linkWhatsapp(userId, phoneNumber) {
  try {
    const cleaned = cleanNumber(phoneNumber);
    if (!cleaned) return { success: false, message: "Nomor WhatsApp tidak valid" };
    const { data: existing } = await db()
      .from("whatsapp_links")
      .select("user_id")
      .eq("phone_number", cleaned)
      .neq("user_id", userId)
      .single();
    if (existing) return { success: false, message: "Nomor WhatsApp sudah terhubung ke akun lain." };
    const { error } = await db().from("whatsapp_links").upsert(
      { user_id: userId, phone_number: cleaned, is_verified: true, linked_at: new Date().toISOString() },
      { onConflict: "user_id" }
    );
    if (error) throw error;
    return { success: true, message: "WhatsApp berhasil dihubungkan!" };
  } catch (e) { return { success: false, message: "Gagal menghubungkan WhatsApp." }; }
}

export async function updateWhatsappPhoneByUserId(userId, rawPhone) {
  try {
    const cleaned = cleanNumber(rawPhone);
    if (!cleaned) return { success: false, message: "Format nomor tidak valid" };
    const { data: conflict } = await db()
      .from("whatsapp_links")
      .select("user_id")
      .eq("phone_number", cleaned)
      .neq("user_id", userId)
      .maybeSingle();
    if (conflict) return { success: false, message: "Nomor sudah dipakai akun lain" };
    const { error } = await db()
      .from("whatsapp_links")
      .update({ phone_number: cleaned })
      .eq("user_id", userId);
    if (error) throw error;
    return { success: true };
  } catch (e) { err("updateWhatsappPhoneByUserId", "Error", e); return { success: false, message: "Gagal update nomor" }; }
}

export async function unlinkWhatsapp(userId) {
  try {
    const { error } = await db().from("whatsapp_links").delete().eq("user_id", userId);
    if (error) throw error;
    return true;
  } catch (e) { err("unlinkWhatsapp", "Error", e); return false; }
}

// Ambil semua nomor WhatsApp yang terhubung ke akun admin
export async function getAdminWhatsAppNumbers() {
  try {
    const { data: adminRoles, error: rolesErr } = await db()
      .from("user_roles")
      .select("user_id")
      .eq("role", "admin");
    if (rolesErr || !adminRoles?.length) return [];
    const adminIds = adminRoles.map(r => r.user_id);
    const { data, error } = await db()
      .from("whatsapp_links")
      .select("user_id, phone_number")
      .in("user_id", adminIds)
      .eq("is_verified", true);
    if (error) throw error;
    return data || [];
  } catch (e) { err("getAdminWhatsAppNumbers", "Error", e); return []; }
}

// Kumpulkan semua data konteks user (profil, tanaman, diagnosa, riwayat chat, dll)
export async function buildUserContext(userId) {
  try {
    const [profileRes, plantsRes, diagnosesRes, historyRes, communityRes, articlesRes] = await Promise.all([
      db().from("profiles")
        .select("full_name, location, farmer_type, bio")
        .eq("id", userId)
        .single(),

      db().from("user_plants")
        .select("name, type, status, location, soil_condition, notes, plant_date, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(15),

      db().from("plant_diagnoses")
        .select("plant_type, part_type, diagnosis, detected_plant, symptoms, solution, cause, severity, confidence_score, initial_action, follow_up, fertilizer, pesticide, recovery_days, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(10),

      db().from("whatsapp_chats")
        .select("message, response, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(5),

      db().from("community_posts")
        .select("title, category, likes_count, comments_count, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(3),

      db().from("articles")
        .select("title, slug, excerpt, content, created_at")
        .eq("published", true)
        .order("created_at", { ascending: false })
        .limit(5),
    ]);

    const profile = profileRes.data ?? {};
    const plants = plantsRes.data ?? [];
    const diagnoses = diagnosesRes.data ?? [];
    const chatHistory = (historyRes.data ?? []).reverse();
    const communityPosts = communityRes.data ?? [];
    const articles = articlesRes.data ?? [];

    const plantSummary = plants.map(p => ({
      nama: p.name,
      jenis: p.type || "-",
      status: p.status || "-",
      lokasi: p.location || "-",
      kondisiTanah: p.soil_condition || "-",
      catatan: p.notes || "-",
      tanggalTanam: formatDate(p.plant_date || p.created_at),
      umurHari: daysSince(p.plant_date || p.created_at),
    }));

    const diagnosisSummary = diagnoses.map(d => ({
      tanaman: d.plant_type || d.detected_plant || "-",
      bagian: d.part_type || "-",
      diagnosis: d.diagnosis || "-",
      gejala: d.symptoms || "-",
      penyebab: d.cause || "-",
      solusi: d.solution || "-",
      tindakanAwal: d.initial_action || "-",
      tindakLanjut: d.follow_up || "-",
      pupuk: d.fertilizer || "-",
      pestisida: d.pesticide || "-",
      keparahan: d.severity || "-",
      kepercayaan: d.confidence_score ? `${d.confidence_score}%` : "-",
      estimasiPulih: d.recovery_days ? `${d.recovery_days} hari` : "-",
      tanggal: formatDate(d.created_at),
    }));

    const stats = {
      totalTanaman: plants.length,
      tanamanAktif: plants.filter(p => p.status === "Aktif").length,
      totalDiagnosa: diagnoses.length,
      diagnosaHariIni: diagnoses.filter(d => daysSince(d.created_at) === 0).length,
      diagnosaPerTanaman: diagnoses.reduce((acc, d) => {
        const key = d.plant_type || d.detected_plant || "Tidak diketahui";
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}),
    };

    return {
      userId,
      profile,
      plants: plantSummary,
      diagnoses: diagnosisSummary,
      chatHistory,
      communityPosts,
      articles,
      stats,
    };
  } catch (e) { err("buildUserContext", "Error", e); return null; }
}

export async function saveChat({ userId, message, response, hasImage = false }) {
  try {
    const { error } = await db().from("whatsapp_chats").insert({
      user_id: userId,
      message: message.substring(0, 500),
      response: response.substring(0, 2000),
      has_image: hasImage,
      created_at: new Date().toISOString(),
    });
    if (error) throw error;
  } catch (e) { console.error("[saveChat] Error:", e); }
}

// Cek kuota pesan harian user (batas 15 pesan per hari WIB)
export async function checkAndIncrementDailyLimit(userId) {
  try {
    const now = new Date();
    const wibOffset = 7 * 60 * 60 * 1000;
    const todayStart = new Date(Math.floor((now.getTime() + wibOffset) / 86400000) * 86400000 - wibOffset);
    const todayEnd = new Date(todayStart.getTime() + 86400000);

    const { count, error } = await db()
      .from("whatsapp_chats")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("created_at", todayStart.toISOString())
      .lt("created_at", todayEnd.toISOString());

    if (error) throw error;

    const DAILY_LIMIT = 15;
    const currentCount = count || 0;

    if (currentCount >= DAILY_LIMIT) {
      const hoursLeft = Math.ceil((todayEnd.getTime() - now.getTime()) / 3600000);
      return {
        allowed: false,
        count: currentCount,
        limit: DAILY_LIMIT,
        resetMessage: `🚫 *Batas Pesan Harian Tercapai*\n\nKamu sudah menggunakan *${currentCount}/${DAILY_LIMIT} pesan* hari ini.\n\n⏰ Kuota akan direset dalam *${hoursLeft} jam* pada pukul *00.00 WIB*.\n\n💡 Untuk keperluan cepat, Langsung akses https://tani-ai-nexus.vercel.app\n\nTerima kasih sudah menggunakan *TaniAI Nexus*! 🌾`,
      };
    }

    return { allowed: true, count: currentCount, limit: DAILY_LIMIT };
  } catch (e) {
    console.error("[RateLimit] Error:", e);
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
      .select("title, slug, excerpt, content, published, created_at")
      .eq("published", true)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return data || [];
  } catch (e) { err("getLatestArticles", "Gagal", e); return []; }
}

// Parse body notifikasi dari JSON atau teks mentah dengan regex
function parseNotifBody(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { }

  const result = {};
  const postIdMatch = raw.match(/POST_ID:([\w-]+)/);
  if (postIdMatch) result.post_id = postIdMatch[1];
  const reportIdMatch = raw.match(/REPORT_ID:([\w-]+)/);
  if (reportIdMatch) result.report_id = reportIdMatch[1];
  const titleMatch = raw.match(/["""](.{1,100})["""]/);
  if (titleMatch) result.post_title = titleMatch[1];
  const contentAfterTitle = raw.replace(/POST_ID:[\w-]+/, "").replace(/^[^""\n]+/, "").trim();
  if (contentAfterTitle.startsWith("—") || contentAfterTitle.startsWith("-")) {
    result.comment_content = contentAfterTitle.replace(/^[—\-]\s*/, "").trim();
  }
  const commenterMatch = raw.match(/^(.+?) mengomentari/);
  if (commenterMatch) result.commenter_name = commenterMatch[1].replace(/^💬\s*/, "").trim();
  const reporterMatch = raw.match(/Laporan dari ([^:]+):/);
  if (reporterMatch) result.reporter_name = reporterMatch[1].trim();
  const ownerMatch = raw.match(/Postingan.*?"[^"]*".*?oleh (.+?)[.\n]/);
  if (ownerMatch) result.post_owner_name = ownerMatch[1].trim();
  const reasonMatch = raw.match(/[Aa]lasan:\s*([^.\n]+)/);
  if (reasonMatch) result.reason = reasonMatch[1].trim();
  result.raw = raw;
  return result;
}

// Format pesan WA untuk notifikasi komentar komunitas
function formatCommentNotification(body) {
  const appUrl = process.env.FRONTEND_URL || "https://tani-ai-nexus.vercel.app";
  return `💬 *Komentar Baru*\n\n*${body.commenter_name || "Seseorang"}* membalas postingan *"${body.post_title || "postingan"}"*${body.comment_content ? `\n\n"${body.comment_content}"` : ""}\n\n🔗 Buka di Aplikasi untuk melihat detail dari komentar:\n${appUrl}/community?post=${body.post_id || ""}`;
}

// Format pesan WA untuk notifikasi laporan ke admin
function formatReportNotification(body) {
  const appUrl = process.env.FRONTEND_URL || "https://tani-ai-nexus.vercel.app";
  return `⚠️ *LAPORAN POSTINGAN BARU*\n\n📌 *Dilaporkan oleh:* ${body.reporter_name || "Pengguna"}\n👤 *Pemilik postingan:* ${body.post_owner_name || "Pengguna"}\n📋 *Alasan:* ${body.reason || "Tidak disebutkan"}\n\n🔗 Segera tinjau:\n${appUrl}/admin/reports?post=${body.post_id || ""}`;
}

// Format pesan WA untuk notifikasi peringatan ke pemilik postingan
function formatWarningNotification(body) {
  const appUrl = process.env.FRONTEND_URL || "https://tani-ai-nexus.vercel.app";
  return `⚠️ *Postingan Anda Ditandai*\n\nPostingan *"${body.post_title || "postingan"}"* ditandai admin.\n\n📋 *Alasan:* ${body.reason || "melanggar aturan komunitas"}\n\n🔗 ${appUrl}/community?post=${body.post_id || ""}`;
}

function formatGenericNotification(title, body) {
  const cleanBody = typeof body === "string" ? body : JSON.stringify(body);
  return `🔔 *${title}*\n\n${cleanBody.substring(0, 300)}`;
}

const WA_ALLOWED_TYPES = new Set(["community", "warning", "report"]);

// Ambil notifikasi yang belum dikirim ke WA dan format pesannya
export async function getPendingWaNotifications() {
  try {
    const { data: notifs, error } = await db()
      .from("notifications")
      .select("id, user_id, title, body, type, is_admin_action_required, created_at")
      .eq("is_read", false)
      .eq("wa_sent", false)
      .order("created_at", { ascending: true })
      .limit(50);

    if (error) throw error;
    if (!notifs?.length) return [];

    const results = [];

    for (const notif of notifs) {
      if (!WA_ALLOWED_TYPES.has(notif.type)) continue;

      if (notif.type === "report" && notif.is_admin_action_required !== true) {
        await db().from("notifications").update({ wa_sent: true }).eq("id", notif.id);
        continue;
      }

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

      const parsedBody = parseNotifBody(notif.body);
      let message = "";
      if (notif.type === "community") message = formatCommentNotification(parsedBody);
      else if (notif.type === "report") message = formatReportNotification(parsedBody);
      else if (notif.type === "warning") message = formatWarningNotification(parsedBody);
      else message = formatGenericNotification(notif.title, notif.body);

      results.push({
        id: notif.id,
        phone_number: link.phone_number,
        title: notif.title,
        message,
        type: notif.type,
        is_admin_action_required: notif.is_admin_action_required ?? false,
      });
    }

    return results;
  } catch (e) { err("getPendingWaNotifications", "Error", e); return []; }
}

// Tandai notifikasi sebagai sudah dikirim dan sudah dibaca
export async function markNotificationSent(notifId) {
  try {
    const { error } = await db()
      .from("notifications")
      .update({ wa_sent: true, is_read: true })
      .eq("id", notifId)
      .eq("wa_sent", false);
    if (error) throw error;
  } catch (e) { err("markNotificationSent", "Error", e); }
}

export async function createNotification({ user_id, title, body, type = "info", is_admin_action_required = false }) {
  try {
    const { data, error } = await db()
      .from("notifications")
      .insert({ user_id, title, body, type, wa_sent: false, is_read: false, is_admin_action_required })
      .select()
      .single();
    if (error) throw error;
    return data;
  } catch (e) { err("createNotification", "Error", e); return null; }
}

// Buat notifikasi laporan khusus admin, kirim WA hanya jika status memerlukan tindakan
export async function createReportNotification({ title, body, reportStatus = "pending_review" }) {
  try {
    const ALLOWED_STATUSES_FOR_WA = ["approved_admin_action", "needs_immediate_action"];
    const shouldSendWA = ALLOWED_STATUSES_FOR_WA.includes(reportStatus);
    const admins = await getAdminWhatsAppNumbers();
    if (!admins.length) { console.warn("[DB] createReportNotification: tidak ada admin dengan WA terhubung"); return null; }
    const admin = admins[0];
    const { data, error } = await db()
      .from("notifications")
      .insert({ user_id: admin.user_id, title, body, type: "report", wa_sent: false, is_read: false, is_admin_action_required: shouldSendWA })
      .select()
      .single();
    if (error) throw error;
    return data;
  } catch (e) { err("createReportNotification", "Error", e); return null; }
}