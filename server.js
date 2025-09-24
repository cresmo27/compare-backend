import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ====== Config ======
const {
  PORT = 8080,

  // OpenAI
  OPENAI_API_KEY,
  OPENAI_MODEL = "gpt-4o-mini",

  // Gemini
  GEMINI_API_KEY,
  GEMINI_MODEL = "gemini-2.5-flash-lite",

  // Claude (Anthropic)
  ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL = "claude-3-5-sonnet-latest",
  ANTHROPIC_MAX_TOKENS, // opcional, si no, usamos MAX_TOKENS_OUT

  // Resumen
  SUMMARY_PROVIDER = "gemini",

  // Control de salida / temperatura
  MAX_TOKENS_OUT = "350",
  TEMP = "0.3",

  // Control de planes
  USERS_JSON = "{}",                // e.g. {"demo-free-123":"free","demo-pro-123":"pro"}
  FREE_MAX_PROVIDERS = "2",
  FREE_ALLOW_SUMMARY = "false",
  FREE_DAILY_QUOTA = "50"
} = process.env;

const maxOut = parseInt(MAX_TOKENS_OUT, 10) || 350;
const anthMax = parseInt(ANTHROPIC_MAX_TOKENS || MAX_TOKENS_OUT, 10) || 350;
const temperature = Number(TEMP) || 0.3;
const freeMaxProviders = parseInt(FREE_MAX_PROVIDERS, 10) || 2;
const freeAllowSummary = (FREE_ALLOW_SUMMARY || "false").toLowerCase() === "true";
const freeDailyQuota = parseInt(FREE_DAILY_QUOTA, 10) || 50;

// In-memory usage counters (MVP)
const usage = new Map();
function todayKey() {
  const d = new Date();
  return d.toISOString().slice(0,10); // YYYY-MM-DD
}
function getPlanFromToken(token) {
  try {
    const map = JSON.parse(USERS_JSON || "{}");
    return map[token] || "free";
  } catch {
    return "free";
  }
}
function checkAndCountQuota(token, plan) {
  const key = (token || "anon") + "|" + todayKey();
  const stat = usage.get(key) || { count: 0 };
  if (plan === "free" && stat.count >= freeDailyQuota) {
    return { ok: false, remaining: 0 };
  }
  stat.count += 1;
  usage.set(key, stat);
  const remaining = (plan === "free") ? Math.max(0, freeDailyQuota - stat.count) : Infinity;
  return { ok: true, remaining };
}

// Helper: timeout
function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort("timeout"), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(id));
}

// ===================== Providers ===================== //
async function askOpenAI(prompt) {
  if (!OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY");
  const res = await fetchWithTimeout("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: prompt,
      max_output_tokens: maxOut,
      temperature
    })
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status} ${await res.text()}`);
  const data = await res.json();
  const text = data.output_text ?? (data.output?.[0]?.content?.[0]?.text ?? "");
  return text;
}

async function askGemini(prompt) {
  if (!GEMINI_API_KEY) throw new Error("Falta GEMINI_API_KEY");
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetchWithTimeout(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }]}],
      generationConfig: { maxOutputTokens: maxOut, temperature }
    })
  });
  if (!res.ok) throw new Error(`Gemini ${res.status} ${await res.text()}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join("\n") ?? "";
  return text || JSON.stringify(data);
}

// >>> NUEVO: Claude (Anthropic)
async function askClaude(prompt) {
  if (!ANTHROPIC_API_KEY) throw new Error("Falta ANTHROPIC_API_KEY");
  const res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: anthMax,
      messages: [{ role: "user", content: prompt }]
    })
  });
  if (!res.ok) throw new Error(`Claude ${res.status} ${await res.text()}`);
  const data = await res.json();
  // data.content es un array de bloques; nos quedamos con los "text"
  const text = Array.isArray(data?.content)
    ? data.content.map(c => c?.text || "").join("\n")
    : "";
  return text || JSON.stringify(data);
}
// =================== /Providers ====================== //

// Enforce plan rules
function enforcePlan(plan, providers, doSummary) {
  // prioridad: ajusta como prefieras
  const ordered = ["openai","gemini","claude"];
  const selected = ordered.filter(p => providers?.[p]);

  let allowed = selected;
  if (plan === "free" && selected.length > freeMaxProviders) {
    allowed = selected.slice(0, freeMaxProviders);
  }

  const enforced = {
    openai: allowed.includes("openai"),
    gemini: allowed.includes("gemini"),
    claude: allowed.includes("claude")
  };

  const allowSummary = (plan === "pro") ? doSummary : (freeAllowSummary && doSummary);
  return { enforced, allowSummary };
}

// ======================= Routes ======================= //
app.post("/compare", async (req, res) => {
  try {
    const token = req.headers["x-app-key"] || req.body?.appKey || "";
    const plan = getPlanFromToken(token);
    const quota = checkAndCountQuota(token, plan);
    if (!quota.ok) {
      return res.status(429).json({ error: "Daily quota exceeded (free plan).", plan, remaining: 0 });
    }

    const {
      prompt,
      providers = { openai:true, gemini:true, claude:true },
      doSummary = false
    } = req.body || {};
    if (!prompt) return res.status(400).json({ error: "Falta 'prompt'", plan, remaining: quota.remaining });

    const { enforced, allowSummary } = enforcePlan(plan, providers, doSummary);

    const results = [];
    const tasks = [];

    if (enforced.openai) {
      tasks.push(
        askOpenAI(prompt)
          .then(text => results.push({ provider: "OpenAI", text }))
          .catch(err => results.push({ provider: "OpenAI", error: String(err.message || err) }))
      );
    }
    if (enforced.gemini) {
      tasks.push(
        askGemini(prompt)
          .then(text => results.push({ provider: "Gemini", text }))
          .catch(err => results.push({ provider: "Gemini", error: String(err.message || err) }))
      );
    }
    if (enforced.claude) {
      tasks.push(
        askClaude(prompt)
          .then(text => results.push({ provider: "Claude", text }))
          .catch(err => results.push({ provider: "Claude", error: String(err.message || err) }))
      );
    }

    await Promise.all(tasks);

    let summary = "";
    if (allowSummary && results.length) {
      const joined = results.map(r => `### ${r.provider}\n${r.text || r.error || ""}`).join("\n\n");
      const sumPrompt = `Resume en 3 viñetas (máx 80 palabras) coincidencias y diferencias, neutro y conciso.\n\n${joined}`;
      try {
        const sp = (SUMMARY_PROVIDER || "gemini").toLowerCase();
        if (sp === "gemini") summary = await askGemini(sumPrompt);
        else if (sp === "openai") summary = await askOpenAI(sumPrompt);
        else if (sp === "claude") summary = await askClaude(sumPrompt);
        else summary = await askGemini(sumPrompt);
      } catch {
        summary = "No se pudo generar resumen.";
      }
    }

    res.json({
      plan,
      remaining: quota.remaining,
      providers_enforced: enforced,
      results,
      summary
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/health", (_, res) => res.json({ ok: true }));
app.get("/me", (req, res) => {
  const token = req.headers["x-app-key"] || "";
  const plan = getPlanFromToken(token);
  const quota = checkAndCountQuota(token, plan); // cuenta una consulta simple
  res.json({ plan, remaining: quota.remaining });
});

app.listen(PORT, () => console.log(`✅ compare-backend-pro en http://localhost:${PORT}`));
