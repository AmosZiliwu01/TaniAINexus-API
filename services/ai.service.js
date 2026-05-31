// ai.service.js v2 — dengan validasi gambar bukan tanaman
import Groq from "groq-sdk";
import { getLatestArticles } from "./db.service.js";

if (!process.env.GROQ_API_KEY) {
  console.error("❌ [AI] GROQ_API_KEY tidak ditemukan.");
}

const groq         = new Groq({ apiKey: process.env.GROQ_API_KEY });
const TEXT_MODEL   = "llama-3.3-70b-versatile";
const VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";
const FALLBACK_MSG = "Maaf, TaniAI sedang tidak bisa menjawab saat ini. Silakan coba lagi sebentar ya! 🌾";

// ─────────────────────────────────────────────────────────────
// SYSTEM PROMPT
// ─────────────────────────────────────────────────────────────
function buildSystemPrompt(ctx, isVision = false) {
  const { profile, plants, diagnoses } = ctx || {};
  const name = profile?.full_name?.trim() || "Sahabat Tani";

  let plantsSummary = "";
  if (plants?.length) {
    const active = plants.filter((p) => p.status === "Aktif").map((p) => p.name);
    plantsSummary = active.length ? `Tanaman aktif: ${active.join(", ")}` : "";
  }

  let diagSummary = "";
  if (diagnoses?.length) {
    const last = diagnoses[0];
    diagSummary = `Diagnosa terakhir: ${last.plant_type}`;
  }

  const visionExtra = isVision
    ? `
ATURAN KHUSUS GAMBAR:
- Jika gambar BUKAN tanaman, bagian tanaman, lahan pertanian, hama, atau hal yang berkaitan langsung dengan pertanian:
  Tolak dengan sopan: "Maaf, saya hanya bisa menganalisis foto tanaman atau hal terkait pertanian. Silakan kirim foto tanaman yang ingin dianalisis ya! 🌱"
- JANGAN menganalisis foto selfie, makanan jadi, hewan peliharaan non-hama, objek elektronik, screenshot, dokumen, atau gambar acak.
- Jika gambar tanaman tapi kualitas buruk/buram, minta foto ulang dengan pencahayaan lebih baik.
`
    : "";

  return `Anda TaniAI, asisten pertanian untuk ${name}. ${plantsSummary} ${diagSummary}
ATURAN WAJIB TANIAINEXUS

1. Fokus utama membantu petani dengan informasi pertanian yang praktis, mudah dipahami, dan dapat diterapkan.
2. Berikan jawaban singkat (2-3 kalimat), kecuali pengguna meminta penjelasan detail.
3. Gunakan bahasa Indonesia yang sederhana dan ramah. Hindari istilah teknis yang sulit tanpa penjelasan.
4. Jika pengguna mengirim foto tanaman, lakukan analisis berdasarkan gejala yang terlihat pada gambar terlebih dahulu.
5. Jika diagnosis tidak yakin, gunakan kalimat: "Kemungkinan penyebabnya adalah..." dan jangan mengklaim 100% benar.
6. Selalu sertakan solusi atau langkah tindakan yang dapat dilakukan petani setelah menjelaskan masalah.
7. Prioritaskan solusi yang murah, mudah didapat, dan aman bagi petani.
8. Jika ada beberapa kemungkinan penyebab, urutkan dari yang paling umum terjadi.
9. Jangan membuat data, fakta, penyakit, hama, atau artikel yang tidak tersedia.
10. Jika pengguna bertanya isi artikel, gunakan hanya data artikel yang diberikan.
11. Jika informasi tidak diketahui, jawab: "Maaf, saya tidak tahu. Coba tanyakan hal lain ya!"
12. Jangan memberikan saran yang berbahaya, merusak tanaman, atau melanggar hukum.
13. Jika merekomendasikan pestisida atau pupuk, ingatkan pengguna untuk mengikuti dosis pada kemasan.
14. Jika pertanyaan kurang jelas, ajukan maksimal 1-2 pertanyaan lanjutan yang relevan.
15. Jangan mengulang salam, menu, atau informasi yang sudah diberikan sebelumnya.
16. Jika pengguna meminta langkah-langkah, berikan dalam bentuk poin atau nomor.
17. Untuk hasil diagnosis tanaman, gunakan format: Kemungkinan Penyebab / Tingkat Keyakinan / Solusi.
18. Jangan pernah menyebutkan bahwa kamu adalah AI atau model bahasa.
19. Kamu adalah TaniAiNexus, asisten pertanian yang dibuat oleh Amos Aleksiato Ziliwu.
20. Jika pengguna bertanya "siapa yang membuatmu", jawab: "TaniAiNexus dibuat oleh Amos Aleksiato Ziliwu, mahasiswa Informatika Universitas Kristen Immanuel Yogyakarta."
${visionExtra}`;
}

function buildMemoryMessages(history) {
  if (!history?.length) return [];
  return history.slice(-4).flatMap((h) => [
    { role: "user",      content: h.message  },
    { role: "assistant", content: h.response },
  ]);
}

// ─────────────────────────────────────────────────────────────
// VISION — dengan validasi apakah itu gambar tanaman
// ─────────────────────────────────────────────────────────────
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
  const completion = await groq.chat.completions.create({
    model:       VISION_MODEL,
    messages,
    temperature: 0.3,
    max_tokens:  500,
  });
  return completion.choices?.[0]?.message?.content?.trim() ?? "";
}

// ─────────────────────────────────────────────────────────────
// TEXT + ARTIKEL
// ─────────────────────────────────────────────────────────────
async function callTextWithArticles(text, systemPrompt, memoryMessages, articlesData) {
  let finalSystemPrompt = systemPrompt;

  if (articlesData?.length) {
    const articleInfo = articlesData.map((a) => ({
      judul:    a.title,
      kategori: a.category || "Umum",
      ringkasan: (a.excerpt || "").replace(/<[^>]*>/g, "").substring(0, 300),
      isi:       (a.content || "").replace(/<[^>]*>/g, "").substring(0, 1200),
    }));
    finalSystemPrompt += `\n\n[DATA ARTIKEL DARI DATABASE]:\n${JSON.stringify(articleInfo, null, 2)}\n\nJika user bertanya isi artikel, cari yang judulnya cocok dan berikan ringkasannya.`;
  } else {
    finalSystemPrompt += `\n\n[TIDAK ADA DATA ARTIKEL]`;
  }

  const messages = [
    { role: "system", content: finalSystemPrompt },
    ...memoryMessages,
    { role: "user",   content: text },
  ];

  const completion = await groq.chat.completions.create({
    model:       TEXT_MODEL,
    messages,
    temperature: 0.2,
    max_tokens:  800,
  });
  return completion.choices?.[0]?.message?.content?.trim() ?? "";
}

// ─────────────────────────────────────────────────────────────
// FUNGSI UTAMA
// ─────────────────────────────────────────────────────────────
export async function askAI({ text, imageBase64 = null, userContext, isLinked = false }) {
  const memoryMessages = buildMemoryMessages(userContext?.chatHistory ?? []);
  const systemPrompt   = buildSystemPrompt(userContext, !!imageBase64);
  const rawText        = (text || "").trim();

  // Sapaan pertama
  const isFirstMessage = memoryMessages.length === 0;
  const isJustGreeting = /^(halo|hai|hey|hello|pagi|siang|malam|hallo)$/i.test(rawText);
  if (isFirstMessage && isJustGreeting) {
    const name = userContext?.profile?.full_name?.trim() || "Sahabat Tani";
    return `Halo ${name}! 👋\n\nAda yang bisa saya bantu? Tanya langsung atau kirim foto tanaman.`;
  }

  // Bantuan
  if (/^(bantuan|menu|help|tolong)$/i.test(rawText)) {
    return `Saya TaniAI. Anda bisa:\n- Tanya penyakit tanaman\n- Kirim foto untuk diagnosa\n- Tanya isi artikel\n\nAda yang bisa dibantu?`;
  }

  // Mode gambar — vision dengan validasi tanaman
  if (imageBase64?.startsWith("data:")) {
    console.log("[AI] Vision mode");
    try {
      return await callVision(rawText, imageBase64, systemPrompt, memoryMessages);
    } catch (e) {
      console.error("[AI] Vision error:", e.message);
      return "Maaf, analisis gambar gagal. Ceritakan saja masalah tanaman Anda secara teks ya.";
    }
  }

  // Mode teks — ambil artikel untuk konteks
  let articlesData = null;
  try {
    articlesData = await getLatestArticles(5);
    console.log(`[AI] Ambil ${articlesData.length} artikel untuk konteks`);
  } catch (e) {
    console.warn("[AI] Gagal ambil artikel:", e.message);
  }

  // Permintaan isi artikel spesifik
  const isAskContent = /(isi artikel|artikel tentang|baca artikel|ringkasan artikel)/i.test(rawText);
  if (isAskContent && articlesData?.length) {
    const words   = rawText.split(/\s+/);
    const keyword = words.find((w) => w.length > 3 && !/^(isi|artikel|tentang|baca|ringkasan)$/i.test(w)) || "";
    const found   = keyword
      ? articlesData.find((a) => a.title.toLowerCase().includes(keyword.toLowerCase()))
      : articlesData[0];

    if (found) {
      const cleanContent = (found.content || found.excerpt || "Tidak ada konten")
        .replace(/<[^>]*>/g, "")
        .substring(0, 1500);
      return `📄 *${found.title}*\n\n${cleanContent}\n\n_Sumber: TaniAI Nexus_`;
    }
    return `Maaf, artikel tidak ditemukan. Artikel tersedia:\n${articlesData.map((a) => `- ${a.title}`).join("\n")}`;
  }

  // Teks biasa
  console.log("[AI] Text mode");
  try {
    return await callTextWithArticles(rawText || "Tolong bantu saya tentang pertanian.", systemPrompt, memoryMessages, articlesData);
  } catch (e) {
    console.error("[AI] Text error:", e.message);
    return FALLBACK_MSG;
  }
}