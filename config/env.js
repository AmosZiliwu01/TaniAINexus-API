import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

config({ path: resolve(__dirname, "../.env") });

// Validasi env wajib
const REQUIRED_VARS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_ANON_KEY",
  "GROQ_API_KEY",
];

const missing = REQUIRED_VARS.filter((v) => !process.env[v]);

if (missing.length > 0) {
  console.error("❌ [ENV] Variabel berikut tidak ditemukan di .env:");
  missing.forEach((v) => console.error(`   - ${v}`));
  console.error(
    "\n📝 Pastikan file .env ada di root project dengan isi:\n" +
      "   SUPABASE_URL=https://xxx.supabase.co\n" +
      "   SUPABASE_SERVICE_ROLE_KEY=eyJ...\n" +
      "   SUPABASE_ANON_KEY=eyJ...\n" +
      "   GROQ_API_KEY=gsk_...\n"
  );
  process.exit(1);
}

console.log("✅ [ENV] Semua variabel env berhasil dimuat");

export const ENV = {
  SUPABASE_URL:              process.env.SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_ANON_KEY:         process.env.SUPABASE_ANON_KEY,
  GROQ_API_KEY:              process.env.GROQ_API_KEY,
  PORT:                      process.env.PORT || "3000",
  ALLOWED_ORIGINS:           process.env.ALLOWED_ORIGINS || "http://localhost:5173",
};