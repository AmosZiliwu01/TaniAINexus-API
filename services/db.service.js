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

function err(fn, msg, e) { console.error(`[DB:${fn}] ❌ ${msg}:`, e?.message ?? e); }

function cleanNumber(raw) {
  let n = String(raw || "")
    .replace(/@s\.whatsapp\.net$|@lid$|@c\.us$/g, "")
    .replace(/[^0-9]/g, "");
  if (!n) return null;
  if (n.startsWith("0")) n = "62" + n.substring(1);
  else if (!n.startsWith("62") && n.length >= 10 && n.length <= 13) n = "62" + n;
  return n;
}

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
  } catch (e) {
    console.error("[DB] getWhatsappLinkByPhone error:", e);
    return null;
  }
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
  } catch (e) {
    err("getWhatsappLinkByUserId", "Error", e);
    return null;
  }
}

export { getWhatsappLinkByPhone as getWhatsappLink };

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
  } catch (e) {
    return { success: false, message: "Gagal menghubungkan WhatsApp." };
  }
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

export async function buildUserContext(userId) {
  try {
    const [profileRes, plantsRes, diagnosesRes, historyRes, communityRes, articlesRes] = await Promise.all([
      db().from("profiles").select("full_name, location, farmer_type, bio, phone").eq("id", userId).single(),
      db().from("user_plants").select("name, status, type").eq("user_id", userId).order("created_at", { ascending: false }).limit(20),
      db().from("plant_diagnoses").select("plant_type, diagnosis, severity, created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(5),
      db().from("whatsapp_chats").select("message, response, created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(6),
      db().from("community_posts").select("title, category, likes_count, comments_count, created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(3),
      db().from("articles").select("title, slug, excerpt, content, published, created_at").eq("published", true).order("created_at", { ascending: false }).limit(5),
    ]);
    return {
      userId,
      profile: profileRes.data ?? {},
      plants: plantsRes.data ?? [],
      diagnoses: diagnosesRes.data ?? [],
      chatHistory: (historyRes.data ?? []).reverse(),
      communityPosts: communityRes.data ?? [],
      articles: articlesRes.data ?? [],
    };
  } catch (e) { err("buildUserContext", "Error", e); return null; }
}

export async function saveChat({ userId, message, response, hasImage = false }) {
  try {
    const { error } = await db().from("whatsapp_chats").insert({
      user_id: userId, message, response, has_image: hasImage,
    });
    if (error) throw error;
  } catch (e) { err("saveChat", "Gagal", e); }
}

export async function checkAndIncrementDailyLimit(userId) {
  try {
    return { allowed: true, count: 0, limit: "unlimited" };
  } catch (e) {
    err("checkDailyLimit", "Error", e);
    return { allowed: true, count: 0, limit: "unlimited" };
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

function parseNotifBody(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { /* not JSON, parse plain text */ }

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

  const ownerMatch = raw.match(/Postingan.*?"[^"]*".*?oleh (.+?)[\.\n]/);
  if (ownerMatch) result.post_owner_name = ownerMatch[1].trim();

  const reasonMatch = raw.match(/[Aa]lasan:\s*([^\.\n]+)/);
  if (reasonMatch) result.reason = reasonMatch[1].trim();

  result.raw = raw;
  return result;
}

function formatCommentNotification(body) {
  const commenterName = body.commenter_name || "Seseorang";
  const postTitle = body.post_title || "postingan";
  const commentContent = body.comment_content || "";
  const postId = body.post_id || "";
  const appUrl = process.env.FRONTEND_URL || "https://tani-ai-nexus.vercel.app";
  return `💬 *Komentar Baru*\n\n*${commenterName}* membalas postingan *"${postTitle}"*${commentContent ? `\n\n"${commentContent}"` : ""}\n\n🔗 Buka di Aplikasi:\n${appUrl}/community?post=${postId}\n\n_Balas langsung di WhatsApp untuk berinteraksi lebih lanjut._`;
}

function formatReportNotification(body) {
  const appUrl = process.env.FRONTEND_URL || "https://tani-ai-nexus.vercel.app";
  const postId = body.post_id || "";
  return `⚠️ *LAPORAN POSTINGAN BARU*\n\n📌 *Dilaporkan oleh:* ${body.reporter_name || "Pengguna"}\n👤 *Pemilik postingan:* ${body.post_owner_name || "Pengguna"}\n📋 *Alasan:* ${body.reason || "Tidak disebutkan"}\n\n🔗 Segera tinjau:\n${appUrl}/admin/reports?post=${postId}`;
}

function formatWarningNotification(body) {
  const postTitle = body.post_title || "postingan";
  const reason = body.reason || "melanggar aturan komunitas";
  const appUrl = process.env.FRONTEND_URL || "https://tani-ai-nexus.vercel.app";
  const postId = body.post_id || "";
  return `⚠️ *Postingan Anda Ditandai*\n\nPostingan *"${postTitle}"* ditandai admin.\n\n📋 *Alasan:* ${reason}\n\n🔗 ${appUrl}/community?post=${postId}`;
}

function formatGenericNotification(title, body) {
  const cleanBody = typeof body === "string" ? body : JSON.stringify(body);
  return `🔔 *${title}*\n\n${cleanBody.substring(0, 300)}`;
}

export async function getPendingWaNotifications() {
  try {
    const { data: notifs, error } = await db()
      .from("notifications")
      .select("id, user_id, title, body, type, created_at")
      .eq("is_read", false)
      .eq("wa_sent", false)
      .order("created_at", { ascending: true })
      .limit(50);
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

      const parsedBody = parseNotifBody(notif.body);

      let message = "";
      if (notif.type === "community") message = formatCommentNotification(parsedBody);
      else if (notif.type === "report") message = formatReportNotification(parsedBody);
      else if (notif.type === "warning") message = formatWarningNotification(parsedBody);
      else message = formatGenericNotification(notif.title, notif.body);

      results.push({ id: notif.id, phone_number: link.phone_number, title: notif.title, message, type: notif.type });
    }
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
    return data;
  } catch (e) { err("createNotification", "Error", e); return null; }
}

export async function createReportNotification({ title, body }) {
  try {
    const admins = await getAdminWhatsAppNumbers();
    if (!admins.length) return null;

    const admin = admins[0]; // karena cuma 1 admin

    const { data, error } = await db()
      .from("notifications")
      .insert({
        user_id: admin.user_id,
        title,
        body,
        type: "report",
        wa_sent: false,
        is_read: false
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  } catch (e) {
    err("createReportNotification", "Error", e);
    return null;
  }
}