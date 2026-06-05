import Groq from "groq-sdk";
import { getLatestArticles } from "./db.service.js";

if (!process.env.GROQ_API_KEY) {
  console.error("❌ [AI] GROQ_API_KEY tidak ditemukan.");
}

const groq           = new Groq({ apiKey: process.env.GROQ_API_KEY });
const PRIMARY_MODEL  = "llama-3.3-70b-versatile";
const FALLBACK_MODEL = "llama-3.1-8b-instant";
const VISION_MODEL   = "meta-llama/llama-4-scout-17b-16e-instruct";
console.log("GROQ KEY:", process.env.GROQ_API_KEY?.slice(0, 15));
console.log("VISION MODEL:", VISION_MODEL);

function formatDate(dateStr) {
  if (!dateStr) return "-";
  try {
    return new Date(dateStr).toLocaleDateString("id-ID", {
      day: "numeric", month: "short", year: "numeric",
    });
  } catch { return "-"; }
}

function buildContextBlock(ctx) {
  if (!ctx) return "";
  const lines = [];
  const p = ctx.profile || {};
  lines.push("=== DATA AKUN PENGGUNA ===");
  lines.push(`Nama      : ${p.full_name || "Tidak diketahui"}`);
  if (p.location)    lines.push(`Lokasi    : ${p.location}`);
  if (p.farmer_type) lines.push(`Tipe petani: ${p.farmer_type}`);
  if (p.bio)         lines.push(`Bio       : ${p.bio}`);

  const s = ctx.stats || {};
  lines.push("", "=== STATISTIK ===");
  lines.push(`Total tanaman: ${s.totalTanaman ?? 0} (Aktif: ${s.tanamanAktif ?? 0})`);
  lines.push(`Total diagnosa: ${s.totalDiagnosa ?? 0}`);
  if (s.diagnosaPerTanaman && Object.keys(s.diagnosaPerTanaman).length) {
    const freq = Object.entries(s.diagnosaPerTanaman)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} (${v}x)`).join(", ");
    lines.push(`Diagnosa per tanaman: ${freq}`);
  }

  if (ctx.plants?.length) {
    lines.push("", "=== DAFTAR TANAMAN ===");
    ctx.plants.forEach((pl, i) => {
      lines.push(`[${i + 1}] ${pl.nama} | Jenis: ${pl.jenis} | Status: ${pl.status} | Umur: ${pl.umurHari != null ? pl.umurHari + " hari" : "-"} | Tanam: ${pl.tanggalTanam || "-"} | Lokasi: ${pl.lokasi} | Tanah: ${pl.kondisiTanah}${pl.catatan && pl.catatan !== "-" ? ` | Catatan: ${pl.catatan}` : ""}`);
    });
  }

  if (ctx.diagnoses?.length) {
    lines.push("", "=== RIWAYAT DIAGNOSA ===");
    ctx.diagnoses.forEach((d, i) => {
      lines.push(`[${i + 1}] Tanggal: ${d.tanggal} | Tanaman: ${d.tanaman} | Bagian: ${d.bagian}`);
      lines.push(`    Diagnosis : ${d.diagnosis}`);
      if (d.gejala       !== "-") lines.push(`    Gejala    : ${d.gejala}`);
      if (d.penyebab     !== "-") lines.push(`    Penyebab  : ${d.penyebab}`);
      if (d.keparahan    !== "-") lines.push(`    Keparahan : ${d.keparahan} (Kepercayaan: ${d.kepercayaan})`);
      if (d.solusi       !== "-") lines.push(`    Solusi    : ${d.solusi}`);
      if (d.tindakanAwal !== "-") lines.push(`    Tindakan awal: ${d.tindakanAwal}`);
      if (d.tindakLanjut !== "-") lines.push(`    Tindak lanjut: ${d.tindakLanjut}`);
      if (d.pupuk        !== "-") lines.push(`    Pupuk     : ${d.pupuk}`);
      if (d.pestisida    !== "-") lines.push(`    Pestisida : ${d.pestisida}`);
      if (d.estimasiPulih !== "-") lines.push(`    Est. pulih: ${d.estimasiPulih}`);
    });
  }

  if (ctx.communityPosts?.length) {
    lines.push("", "=== POSTINGAN KOMUNITAS ===");
    ctx.communityPosts.forEach((post, i) => {
      lines.push(`[${i + 1}] ${post.title} | Kategori: ${post.category || "-"} | Suka: ${post.likes_count} | Komentar: ${post.comments_count} | Tanggal: ${formatDate(post.created_at)}`);
    });
  }

  return lines.join("\n");
}

function buildSystemPrompt(ctx, isVision = false) {
  const name         = ctx?.profile?.full_name?.trim() || "Sahabat Tani";
  const contextBlock = buildContextBlock(ctx);

  const visionExtra = isVision ? `
ATURAN ANALISIS GAMBAR:
- TERIMA & ANALISIS gambar: tanaman, daun, batang, akar, bunga, buah/sayur, hama, penyakit, lahan, pupuk, alat tani.
- TOLAK hanya jika SAMA SEKALI tidak terkait pertanian: selfie, makanan matang, hewan peliharaan, dokumen, elektronik.
- FORMAT WAJIB (gunakan persis format ini, jangan pakai ###, jangan pakai bullet •):
  *Gejala:* [1-2 kalimat singkat]
  *Kemungkinan Penyebab:* [nama penyakit/hama] ([persentase keyakinan]%)
  *Solusi:*
  1. [tindakan 1]
  2. [tindakan 2]
  3. [tindakan 3]
  _Ikuti dosis pada kemasan pestisida/pupuk._
- Maksimal 3 solusi, masing-masing 1 kalimat singkat.
- JANGAN gunakan heading markdown (###), JANGAN gunakan bullet (·), gunakan hanya format WhatsApp: *bold*, _italic_, angka bernomor.
` : "";

  return `Anda TaniAI, asisten pertanian pribadi untuk ${name}.

${contextBlock}

ATURAN WAJIB:
1. Gunakan DATA AKUN di atas untuk menjawab pertanyaan tentang tanaman, diagnosa, atau riwayat pengguna.
2. Jawaban singkat 2-3 kalimat kecuali pengguna minta detail.
3. Bahasa Indonesia sederhana dan ramah.
4. JANGAN gunakan heading markdown (###) atau bullet simbol (·). Format hanya: *bold*, _italic_, angka bernomor, tanda hubung (-).
5. Jika diagnosis tidak yakin, gunakan "Kemungkinan penyebabnya adalah..."
6. Selalu sertakan solusi setelah menjelaskan masalah.
7. Prioritaskan solusi murah, mudah didapat, dan aman.
8. Jangan membuat data atau fakta yang tidak tersedia.
9. Jika informasi tidak diketahui: "Maaf, saya tidak tahu. Coba tanyakan hal lain ya!"
10. Jangan saran berbahaya atau melanggar hukum.
11. Jika merekomendasikan pestisida/pupuk, ingatkan ikuti dosis kemasan.
12. Jika pertanyaan kurang jelas, ajukan maksimal 1-2 pertanyaan lanjutan.
13. Jangan mengulang salam atau informasi yang sudah diberikan.
14. Jika diminta langkah-langkah, gunakan angka bernomor.
15. Jangan menyebutkan bahwa kamu adalah AI atau model bahasa.
16. Kamu adalah TaniAiNexus, asisten pertanian untuk petani Indonesia.
17. Jika ditanya siapa pembuatmu: "TaniAiNexus dibuat oleh Amos Aleksiato Ziliwu, mahasiswa Informatika Universitas Kristen Immanuel Yogyakarta."
18. Data pengguna bersifat rahasia, jangan bagikan ke siapapun.
${visionExtra}`;
}

function buildMemoryMessages(history) {
  if (!history?.length) return [];
  return history.slice(-4).flatMap((h) => [
    { role: "user",      content: h.message  },
    { role: "assistant", content: h.response },
  ]);
}

function formatWhatsAppResponse(text) {
  if (!text || typeof text !== "string") return text;

  let f = text;

  // Hapus heading markdown ### apapun
  f = f.replace(/^#{1,6}\s+/gm, "");

  // Konversi bullet markdown (- atau *) di awal baris ke tanda hubung rapi
  f = f.replace(/^[\*\-•·]\s+/gm, "- ");

  // Markdown bold → WhatsApp bold
  f = f.replace(/\*\*(.*?)\*\*/g, "*$1*");
  f = f.replace(/__(.*?)__/g, "*$1*");

  // Hapus triple+ newline
  f = f.replace(/\n{3,}/g, "\n\n");

  // Spasi setelah emoji
  f = f.replace(/(⚠️|✅|📊|💡|🌱|🚫|📌|👋|🌾)([^\s])/g, "$1 $2");

  return f.trim();
}

async function callTextModel(messages, temperature = 0.2, max_tokens = 700) {
  try {
    const res = await groq.chat.completions.create({ model: PRIMARY_MODEL, messages, temperature, max_tokens });
    return res.choices?.[0]?.message?.content?.trim() ?? "";
  } catch (e) {
    const msg = e?.message || "";
    if (msg.includes("Rate limit reached") || msg.includes("rate_limit_exceeded")) {
      console.warn(`[AI] ${PRIMARY_MODEL} limit, fallback ke ${FALLBACK_MODEL}`);
      try {
        const res = await groq.chat.completions.create({ model: FALLBACK_MODEL, messages, temperature, max_tokens });
        return res.choices?.[0]?.message?.content?.trim() ?? "";
      } catch (fe) {
        if ((fe?.message || "").includes("Rate limit")) return "🌾 TaniAI sedang ramai. Coba lagi beberapa menit ya.";
        throw fe;
      }
    }
    throw e;
  }
}

async function callVision(text, imageBase64, systemPrompt, memoryMessages) {
  const messages = [
    { role: "system", content: systemPrompt },
    ...memoryMessages,
    {
      role: "user",
      content: [
        { type: "text",      text: text || "Analisis gambar ini." },
        { type: "image_url", image_url: { url: imageBase64, detail: "high" } },
      ],
    },
  ];
  const res = await groq.chat.completions.create({
    model: VISION_MODEL, messages, temperature: 0.3,
    max_tokens: 500, // cukup untuk format ringkas 3 bagian
  });
  return res.choices?.[0]?.message?.content?.trim() ?? "";
}

async function callTextWithArticles(text, systemPrompt, memoryMessages, articlesData) {
  let prompt = systemPrompt;
  if (articlesData?.length) {
    const info = articlesData.map((a) => ({
      judul:     a.title,
      kategori:  a.category || "Umum",
      ringkasan: (a.excerpt || "").replace(/<[^>]*>/g, "").substring(0, 300),
      isi:       (a.content || "").replace(/<[^>]*>/g, "").substring(0, 1200),
    }));
    prompt += `\n\n[DATA ARTIKEL]:\n${JSON.stringify(info, null, 2)}\n\nJika user tanya isi artikel, cari judul yang cocok lalu ringkas.`;
  } else {
    prompt += `\n\n[TIDAK ADA DATA ARTIKEL]`;
  }
  const messages = [
    { role: "system", content: prompt },
    ...memoryMessages,
    { role: "user",   content: text },
  ];
  return await callTextModel(messages, 0.2, 700);
}

export async function askAI({ text, imageBase64 = null, userContext, isLinked = false }) {
  const memoryMessages = buildMemoryMessages(userContext?.chatHistory ?? []);
  const systemPrompt   = buildSystemPrompt(userContext, !!imageBase64);
  const rawText        = (text || "").trim();

  const isFirstMessage = memoryMessages.length === 0;
  const isJustGreeting = /^(halo|hai|hey|hello|pagi|siang|malam|hallo)$/i.test(rawText);
  if (isFirstMessage && isJustGreeting) {
    const name = userContext?.profile?.full_name?.trim() || "Sahabat Tani";
    return formatWhatsAppResponse(`Halo ${name}! 👋\n\nAda yang bisa saya bantu? Tanya langsung atau kirim foto tanaman.`);
  }

  if (/^(bantuan|menu|help|tolong)$/i.test(rawText)) {
    return formatWhatsAppResponse(
      `Saya TaniAI. Anda bisa:\n- Tanya penyakit tanaman\n- Kirim foto untuk diagnosa\n- Tanya isi artikel\n- Tanya riwayat tanaman atau diagnosa Anda\n\nAda yang bisa dibantu?`
    );
  }

  if (imageBase64?.startsWith("data:")) {
    console.log("[AI] Vision mode");
    try {
      const result = await callVision(rawText, imageBase64, systemPrompt, memoryMessages);
      return formatWhatsAppResponse(result);
    } catch (e) {
      console.error("[AI] Vision error:", e.message);
      return "Maaf, analisis gambar gagal. Ceritakan masalah tanaman Anda lewat teks ya.";
    }
  }

  let articlesData = null;
  try {
    articlesData = await getLatestArticles(5);
    console.log(`[AI] Ambil ${articlesData.length} artikel`);
  } catch (e) {
    console.warn("[AI] Gagal ambil artikel:", e.message);
  }

  const isAskContent = /(isi artikel|artikel tentang|baca artikel|ringkasan artikel)/i.test(rawText);
  if (isAskContent && articlesData?.length) {
    const words   = rawText.split(/\s+/);
    const keyword = words.find((w) => w.length > 3 && !/^(isi|artikel|tentang|baca|ringkasan)$/i.test(w)) || "";
    const found   = keyword
      ? articlesData.find((a) => a.title.toLowerCase().includes(keyword.toLowerCase()))
      : articlesData[0];

    if (found) {
      const clean = (found.content || found.excerpt || "Tidak ada konten")
        .replace(/<[^>]*>/g, "").substring(0, 1500);
      return formatWhatsAppResponse(`📄 *${found.title}*\n\n${clean}\n\n_Sumber: TaniAI Nexus_`);
    }
    return formatWhatsAppResponse(
      `Maaf, artikel tidak ditemukan. Artikel tersedia:\n${articlesData.map((a) => `- ${a.title}`).join("\n")}`
    );
  }

  console.log("[AI] Text mode");
  try {
    const result = await callTextWithArticles(
      rawText || "Tolong bantu saya tentang pertanian.",
      systemPrompt, memoryMessages, articlesData
    );
    return formatWhatsAppResponse(result);
  } catch (e) {
    console.error("[AI] Text error:", e.message);
    if ((e?.message || "").includes("Rate limit")) {
      return "🌾 TaniAI sedang ramai digunakan. Coba lagi beberapa menit ya.";
    }
    return "Maaf, TaniAI sedang tidak bisa menjawab. Silakan coba lagi sebentar ya! 🌾";
  }
}