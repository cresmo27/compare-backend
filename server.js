// server.js — Multi-IA Compare (v1.11 fusionado)
// - Mantiene tu estructura original (logging, debug, 404/err handlers, SIMULATE, runners)
// - Añade soporte de userKeys por proveedor (prioriza la clave del usuario)
// - Añade espejo de uso /v1/usage/increment (idempotente por requestId)
// - Enmascara userKeys en logs

import express from "express";
import cors from "cors";
import crypto from "crypto";

const app = express();

// ---------- Config ----------
app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"] }));
app.use(express.json({ limit: "1mb" }));

// ---------- Logging simple ----------
app.use((req, res, next) => {
  req.id = req.headers["x-request-id"] || crypto.randomUUID();
  const t0 = Date.now();
  console.log(`[REQ ${req.id}] ${req.method} ${req.originalUrl}`);
  res.on("finish", () => {
    const ms = Date.now() - t0;
    console.log(
      `[RES ${req.id}] ${res.statusCode} ${req.method} ${req.originalUrl} (${ms}ms)`
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
    if (m.name === "router" && m.handle?.stack) {
      m.handle.stack.forEach((h) => {
        if (h.route?.path) {
          const methods = Object.keys(h.route.methods)
            .filter((k) => h.route.methods[k])
            .map((m) => m.toUpperCase());
          routes.push({ path: h.route.path, methods });
        }
      });
    }
  });
  res.json({ ok: true, count: routes.length, routes });
});

// =========================================================
// ==================== Helpers nuevos =====================
// =========================================================

// Flag de simulación (por defecto true para no romper nada)
const SIMULATE = String(process.env.SIMULATE ?? "true").toLowerCase() !== "false";

// Defaults de modelos si no se pasan desde el front
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

// Enmascara userKeys en logs
function scrub(obj) {
  if (!obj) return obj;
  const copy = JSON.parse(JSON.stringify(obj));
  if (copy.userKeys) {
    for (const k of Object.keys(copy.userKeys)) copy.userKeys[k] = "***";
  }
  return copy;
}

// Espejo de uso en memoria (si luego quieres Redis/DB es trivial enchufarlo)
const usageStore = new Map(); // key: `${deviceId}:${date}` -> { openai, claude, gemini, _reqs:Set }

// =========================================================
// =============  COMPARE MULTI (handlers)  ================
// =========================================================

/**
 * Entrada esperada:
 *  { prompt, providers | selectedIAs, models, temperature, userKeys?: { openai?, claude?, gemini? } }
 *
 * Salida:
 *  { ok:true, openai?: "...", claude?: "...", gemini?: "..." } // solo lo pedido
 *
 * Notas:
 *  - userKeys tiene prioridad sobre variables de entorno por proveedor.
 *  - SIMULATE=true (por defecto) → devuelve respuestas simuladas aunque haya API keys.
 */
app.post("/v1/compare-multi", async (req, res) => {
  try {
    const body = req.body || {};
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";

    if (!prompt) {
      return res.status(400).json({ ok: false, error: "prompt requerido" });
    }

    // Compatibilidad de nombre (frontend antiguo vs nuevo)
    const rawProviders =
      (Array.isArray(body.providers) && body.providers) ||
      (Array.isArray(body.selectedIAs) && body.selectedIAs) ||
      [];

    // Si no se envía nada, compat: usar los 3
    const want =
      rawProviders.length > 0
        ? Array.from(
            new Set(
              rawProviders
                .map((s) => String(s || "").toLowerCase())
                .filter((s) => s === "openai" || s === "claude" || s === "gemini")
            )
          )
        : ["openai", "claude", "gemini"];

    // Modelos y temperatura opcionales
    const models = body.models || {};
    const temperature =
      typeof body.temperature === "number" ? body.temperature : undefined;

    // Claves personales (prioridad si llegan)
    const userKeys = body.userKeys || {};

    // Mapa de runners (todas DEFINIDAS para evitar ReferenceError)
    const runners = {
      openai: runOpenAIOrSim,
      claude: runClaudeOrSim,
      gemini: runGeminiOrSim,
    };

    const out = { ok: true };

    // Ejecutar SOLO lo pedido (con selección de apiKey por proveedor)
    for (const p of want) {
      const fn = runners[p];
      if (!fn) continue; // seguridad

      // Selección de apiKey: userKey > env > undefined
      const apiKey =
        userKeys[p] ||
        process.env[
          p === "openai"
            ? "OPENAI_API_KEY"
            : p === "claude"
            ? "ANTHROPIC_API_KEY"
            : "GEMINI_API_KEY"
        ];

      const model = models?.[p]; // puede venir undefined → usa default
      out[p] = await fn({ prompt, model, temperature, apiKey });
    }

    console.log("[/v1/compare-multi ok]", {
      id: req.id,
      providers: want,
      body: scrub(body),
    });
    return res.json(out);
  } catch (err) {
    console.error("[/v1/compare-multi] error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "internal", detail: String(err) });
  }
});

// =========================================================
// =============  Runners (Simulación x defecto) ===========
// =========================================================

/**
 * Por defecto SIMULATE=true → siempre responde simulado (sin llamar a APIs).
 * Para activar llamadas reales, pon SIMULATE=false y añade la implementación
 * correspondiente (OpenAI/Anthropic/Gemini) más abajo.
 */

// -------- OpenAI --------
async function runOpenAIOrSim({ prompt, model, temperature, apiKey }) {
  const useModel = model || DEFAULT_MODELS.openai;

  if (SIMULATE || !apiKey) {
    return simText("OpenAI", prompt, useModel, temperature);
  }

  // IMPLEMENTACIÓN REAL (opcional):
  /*
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: useModel,
      messages: [{ role: "user", content: prompt }],
      temperature: typeof temperature === "number" ? temperature : 0.2
    })
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`OpenAI ${resp.status}: ${JSON.stringify(data)}`);
  return data.choices?.[0]?.message?.content || "(sin contenido)";
  */
  return simText("OpenAI", prompt, useModel, temperature);
}

// -------- Claude (Anthropic) --------
async function runClaudeOrSim({ prompt, model, temperature, apiKey }) {
  const useModel = model || DEFAULT_MODELS.claude;

  if (SIMULATE || !apiKey) {
    return simText("Claude", prompt, useModel, temperature);
  }

  // IMPLEMENTACIÓN REAL (opcional):
  /*
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: useModel,
      max_tokens: 1024,
      temperature: typeof temperature === "number" ? temperature : 0.2,
      messages: [{ role: "user", content: prompt }]
    })
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Claude ${resp.status}: ${JSON.stringify(data)}`);
  const content = Array.isArray(data.content) ? data.content.map(c=>c.text).join("\\n") : "";
  return content || "(sin contenido)";
  */
  return simText("Claude", prompt, useModel, temperature);
}

// -------- Gemini --------
async function runGeminiOrSim({ prompt, model, temperature, apiKey }) {
  const useModel = model || DEFAULT_MODELS.gemini;

  if (SIMULATE || !apiKey) {
    return simText("Gemini", prompt, useModel, temperature);
  }

  // IMPLEMENTACIÓN REAL (opcional):
  /*
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(useModel)}:generateContent?key=${apiKey}`;
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }]}],
      generationConfig: {
        temperature: typeof temperature === "number" ? temperature : 0.2
      }
    })
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Gemini ${resp.status}: ${JSON.stringify(data)}`);
  const text = data.candidates?.[0]?.content?.parts?.map(p=>p.text).join("\\n");
  return text || "(sin contenido)";
  */
  return simText("Gemini", prompt, useModel, temperature);
}

// =========================================================
// ===============  Espejo de uso (opcional) ===============
// =========================================================

/**
 * Body: { deviceId, requestId, increments: {openai, claude, gemini}, date: "YYYY-MM-DD", tz: "Europe/Madrid" }
 * Idempotente por requestId.
 */
app.post("/v1/usage/increment", (req, res) => {
  try {
    const { deviceId, requestId, increments, date } = req.body || {};
    if (!deviceId || !requestId || !date || typeof increments !== "object") {
      return res.status(400).json({ ok: false, error: "bad_request" });
    }
    const key = `${deviceId}:${date}`;
    const cur =
      usageStore.get(key) || { openai: 0, claude: 0, gemini: 0, _reqs: new Set() };

    if (cur._reqs.has(requestId)) {
      return res.json({
        ok: true,
        dedup: true,
        openai: cur.openai,
        claude: cur.claude,
        gemini: cur.gemini,
      });
    }

    cur._reqs.add(requestId);
    for (const p of ["openai", "claude", "gemini"]) {
      const add = Number(increments?.[p] || 0);
      if (Number.isFinite(add) && add > 0) cur[p] += add;
    }
    usageStore.set(key, cur);

    res.json({
      ok: true,
      openai: cur.openai,
      claude: cur.claude,
      gemini: cur.gemini,
    });
  } catch (err) {
    console.error("[/v1/usage/increment] error:", err);
    res.status(500).json({ ok: false, error: "internal" });
  }
});

// =========================================================

// 404 JSON consistente
app.use((req, res, next) => {
  if (res.headersSent) return next();
  res.status(404).json({ ok: false, error: "Not Found", path: req.originalUrl });
});

// Manejador de errores
app.use((err, req, res, _next) => {
  const status = err.status || 500;
  const payload = {
    ok: false,
    error: err.message || "Internal Server Error",
    code: err.code || "INTERNAL_ERROR",
    request_id: req.id,
  };
  console.error(`[ERR ${req.id}]`, err);
  if (!res.headersSent) res.status(status).json(payload);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`API listening on :${PORT}`));
