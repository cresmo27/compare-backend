// server.js — Multi-IA Compare (v1.12 + módulo neutral)
// - Basado en v1.11 fusionado (10/10/2025)
// - Añade endpoint /v1/analyze-neutral para análisis de sesgos
// - Mantiene compatibilidad total con compare-multi, usage, health

import authRoutes from "./routes/authRoutes.js";
// import { realModeGuard } from "./middleware/realModeGuard.js"; // ⛔️ Reemplazado por proGuard (ver ruta)
import express from "express";
import cors from "cors";
import crypto from "crypto";

// ✅ Middlewares nuevos (para Modo Real sin capado de límite)
import { authSoft } from "./middleware/authSoft.js";
import { rateLimit } from "./middleware/rateLimit.js";
import { proGuard } from "./middleware/proGuard.js";

const app = express();

// ---------- Config ----------
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Device-Id",
      "X-User-Providers",
    ],
    exposedHeaders: ["Retry-After"],
  })
);
app.use(express.json({ limit: "1mb" }));
app.use("/v1/auth", authRoutes);

// ✅ Importante: leer JWT si existe ANTES de rate-limit y rutas
app.use(authSoft);

// ---------- Logging ----------
app.use((req, res, next) => {
  req.id = req.headers["x-request-id"] || crypto.randomUUID();
  const t0 = Date.now();
  console.log(`[REQ ${req.id}] ${req.method} ${req.originalUrl}`);
  res.on("finish", () => {
    const ms = Date.now() - t0;
    console.log(
      `[RES ${req.id}] ${res.statusCode} (${ms}ms) ${req.originalUrl}`
    );
  });
  next();
});

// ---------- Salud ----------
app.get("/health", (_req, res) => res.json({ ok: true, tag: "health" }));
app.get("/v1/health", (_req, res) => res.json({ ok: true, tag: "health-v1" }));

// ---------- Debug rutas ----------
app.get("/v1/debug-routes", (_req, res) => {
  const routes = [];
  app._router?.stack?.forEach((m) => {
    if (m.route?.path) {
      const methods = Object.keys(m.route.methods)
        .filter((k) => m.route.methods[k])
        .map((m) => m.toUpperCase());
      routes.push({ path: m.route.path, methods });
    }
  });
  res.json({ ok: true, routes });
});

// =========================================================
// ==================== Helpers comunes ====================
// =========================================================

const SIMULATE = String(process.env.SIMULATE ?? "true").toLowerCase() !== "false";

const DEFAULT_MODELS = {
  openai: "gpt-4o-mini",
  claude: "claude-3-haiku-20240307",
  gemini: "gemini-1.5-flash",
};

function simText(provider, prompt, model, temperature) {
  const p = (prompt || "").slice(0, 160).replace(/\s+/g, " ").trim();
  const t = typeof temperature === "number" ? `, temp=${temperature}` : "";
  return `(${provider}) Modelo: ${model}${t}\n\nRespuesta para: "${p}"\n\n[simulado]`;
}

function scrub(obj) {
  if (!obj) return obj;
  const copy = JSON.parse(JSON.stringify(obj));
  if (copy.userKeys) {
    for (const k of Object.keys(copy.userKeys)) copy.userKeys[k] = "***";
  }
  return copy;
}

// =========================================================
// =============  COMPARE MULTI (ya existente)  ============
// =========================================================

// ⛔️ Sustituido el guard anterior para controlar correctamente modo real + límite
// app.use("/v1/compare-multi", realModeGuard);

// ✅ Orden correcto: rateLimit (con bypass si REAL+PRO/keys) → proGuard → handler
app.post("/v1/compare-multi", rateLimit, proGuard, async (req, res) => {
  try {
    const body = req.body || {};
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) return res.status(400).json({ ok: false, error: "prompt requerido" });

    const rawProviders =
      (Array.isArray(body.providers) && body.providers) ||
      (Array.isArray(body.selectedIAs) && body.selectedIAs) ||
      [];

    const want =
      rawProviders.length > 0
        ? Array.from(
            new Set(
              rawProviders
                .map((s) => String(s || "").toLowerCase())
                .filter((s) => ["openai", "claude", "gemini"].includes(s))
            )
          )
        : ["openai", "claude", "gemini"];

    const models = body.models || {};
    const temperature =
      typeof body.temperature === "number" ? body.temperature : undefined;
    const userKeys = body.userKeys || {};

    const runners = {
      openai: runOpenAIOrSim,
      claude: runClaudeOrSim,
      gemini: runGeminiOrSim,
    };

    const out = { ok: true };
    for (const p of want) {
      const fn = runners[p];
      if (!fn) continue;
      const apiKey =
        userKeys[p] ||
        process.env[
          p === "openai"
            ? "OPENAI_API_KEY"
            : p === "claude"
            ? "ANTHROPIC_API_KEY"
            : "GEMINI_API_KEY"
        ];
      const model = models?.[p];
      out[p] = await fn({ prompt, model, temperature, apiKey });
    }

    console.log("[compare-multi OK]", scrub(body));
    return res.json(out);
  } catch (err) {
    console.error("[compare-multi ERR]", err);
    return res.status(500).json({ ok: false, error: "internal" });
  }
});

// =========================================================
// ===============  NUEVO: ANALYZE NEUTRAL  ================
// =========================================================

/**
 * Entrada:
 * { responses: [{id,text},...], options?: {language?,analysis_depth?} }
 * 
 * Salida:
 * { analysis: {...}, metadata: {...} }
 */
app.post("/v1/analyze-neutral", async (req, res) => {
  try {
    const { responses = [], options = {} } = req.body || {};
    if (!Array.isArray(responses) || responses.length === 0) {
      return res.status(400).json({ ok: false, error: "responses requeridas" });
    }

    // Limpieza básica
    const clean = responses.map((r, i) => ({
      id: r.id || String.fromCharCode(65 + i),
      text: String(r.text || "")
        .replace(/\b(ChatGPT|Claude|Gemini|OpenAI|Anthropic)\b/gi, "")
        .trim()
        .slice(0, 4000),
    }));

    // Construcción de prompt neutral
    let prompt = `Analiza los siguientes textos sin conocer la pregunta original ni su autoría.\n\n`;
    prompt += `1. Detecta similitudes de contenido, tono o estructura.\n`;
    prompt += `2. Identifica diferencias relevantes entre ellos.\n`;
    prompt += `3. Indica si alguno parece más parcial, emocional o sesgado políticamente.\n`;
    prompt += `4. Devuelve el resultado en JSON con los campos: coincidencias, diferencias, posibles_sesgos (por id), balance_general (0-100), observaciones.\n`;
    prompt += `Solo analiza el lenguaje, no el fondo del tema.\n\n`;

    for (const r of clean) prompt += `Texto ${r.id}: ${r.text}\n\n`;

    let analysisJSON;
    if (SIMULATE) {
      // --- Modo simulado ---
      analysisJSON = {
        analysis: {
          coincidencias:
            "Los textos comparten un tono informativo y referencias generales.",
          diferencias:
            "El texto A enfatiza causas; el B ofrece datos; el C adopta tono escéptico.",
          posibles_sesgos: {
            A: "Ligeramente emocional.",
            B: "Neutral y técnico.",
            C: "Tendencia a minimizar.",
          },
          balance_general: 82,
          observaciones: "Análisis generado en modo simulado.",
        },
        metadata: {
          engine_used: "simulated",
          timestamp: new Date().toISOString(),
          language: options.language || "es",
        },
      };
    } else {
      // --- Modo real (OpenAI) ---
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("OPENAI_API_KEY no definido");

      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: DEFAULT_MODELS.openai,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.3,
          max_tokens: 600,
        }),
      });

      const data = await resp.json();
      if (!resp.ok) throw new Error(`OpenAI ${resp.status}: ${JSON.stringify(data)}`);
      const text = data.choices?.[0]?.message?.content || "";
      try {
        analysisJSON = JSON.parse(text);
      } catch {
        analysisJSON = {
          analysis: {
            coincidencias: "(Formato no válido en respuesta de modelo)",
            diferencias: "",
            posibles_sesgos: {},
            balance_general: 0,
            observaciones: "Error al parsear JSON devuelto.",
          },
          metadata: {
            engine_used: DEFAULT_MODELS.openai,
            timestamp: new Date().toISOString(),
          },
        };
      }
    }

    res.json(analysisJSON);
  } catch (err) {
    console.error("[/v1/analyze-neutral] error:", err);
    res.status(500).json({ ok: false, error: "internal", detail: String(err) });
  }
});

// =========================================================
// ===============  Runners (Simulación) ===================
// =========================================================

async function runOpenAIOrSim({ prompt, model, temperature, apiKey }) {
  const useModel = model || DEFAULT_MODELS.openai;
  if (SIMULATE || !apiKey) return simText("OpenAI", prompt, useModel, temperature);
  return simText("OpenAI", prompt, useModel, temperature);
}
async function runClaudeOrSim({ prompt, model, temperature, apiKey }) {
  const useModel = model || DEFAULT_MODELS.claude;
  if (SIMULATE || !apiKey) return simText("Claude", prompt, useModel, temperature);
  return simText("Claude", prompt, useModel, temperature);
}
async function runGeminiOrSim({ prompt, model, temperature, apiKey }) {
  const useModel = model || DEFAULT_MODELS.gemini;
  if (SIMULATE || !apiKey) return simText("Gemini", prompt, useModel, temperature);
  return simText("Gemini", prompt, useModel, temperature);
}

// =========================================================
// ===============  Espejo de uso (igual) ==================
// =========================================================

const usageStore = new Map();
app.post("/v1/usage/increment", (req, res) => {
  try {
    const { deviceId, requestId, increments, date } = req.body || {};
    if (!deviceId || !requestId || !date || typeof increments !== "object")
      return res.status(400).json({ ok: false, error: "bad_request" });

    const key = `${deviceId}:${date}`;
    const cur =
      usageStore.get(key) || { openai: 0, claude: 0, gemini: 0, _reqs: new Set() };

    if (cur._reqs.has(requestId))
      return res.json({ ok: true, dedup: true, ...cur });

    cur._reqs.add(requestId);
    for (const p of ["openai", "claude", "gemini"]) {
      const add = Number(increments?.[p] || 0);
      if (Number.isFinite(add) && add > 0) cur[p] += add;
    }
    usageStore.set(key, cur);
    res.json({ ok: true, ...cur });
  } catch (err) {
    console.error("[usage/increment] error:", err);
    res.status(500).json({ ok: false, error: "internal" });
  }
});

// =========================================================
// ===============  404 y error handler ====================
// =========================================================

app.use((req, res, next) => {
  if (res.headersSent) return next();
  res.status(404).json({ ok: false, error: "Not Found", path: req.originalUrl });
});
app.use((err, req, res, _next) => {
  console.error(`[ERR ${req.id}]`, err);
  res.status(500).json({ ok: false, error: err.message || "Internal Error" });
});

// ---------- Listen ----------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`API listening on :${PORT}`));

export default app;
