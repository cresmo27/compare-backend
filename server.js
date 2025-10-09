// server.js (v1.8.1)
import express from "express";
import cors from "cors";
import crypto from "crypto";

const app = express();

// --- Configuración base
app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"] }));
app.use(express.json({ limit: "1mb" }));

// --- Logging simple con request-id y timing
app.use((req, res, next) => {
  req.id = req.headers["x-request-id"] || crypto.randomUUID();
  const t0 = Date.now();
  console.log(`[REQ ${req.id}] ${req.method} ${req.originalUrl}`);
  res.on("finish", () => {
    const ms = Date.now() - t0;
    console.log(`[RES ${req.id}] ${res.statusCode} ${req.method} ${req.originalUrl} (${ms}ms)`);
  });
  next();
});

// --- Salud
app.get("/health", (_req, res) => res.json({ ok: true, tag: "health" }));
app.get("/v1/health", (_req, res) => res.json({ ok: true, tag: "health-v1" }));

// --- Listado de rutas (debug)
app.get("/v1/debug-routes", (_req, res) => {
  const routes = [];
  // Nivel superior
  app._router?.stack?.forEach((m) => {
    if (m.route?.path) {
      const methods = Object.keys(m.route.methods).filter(k => m.route.methods[k]).map(m => m.toUpperCase());
      routes.push({ path: m.route.path, methods });
    }
    // Routers anidados (por si más adelante usas Router())
    if (m.name === "router" && m.handle?.stack) {
      m.handle.stack.forEach((h) => {
        if (h.route?.path) {
          const methods = Object.keys(h.route.methods).filter(k => h.route.methods[k]).map(m => m.toUpperCase());
          routes.push({ path: h.route.path, methods });
        }
      });
    }
  });
  res.json({ ok: true, count: routes.length, routes });
});

/**
 * Multi-IA Compare — v1.10.2-surgical-providers-fix (Backend)
 * Handler de /v1/compare-multi que respeta `providers`.
 *
 * Inserta este bloque dentro de tu server.js y elimina el antiguo handler de /v1/compare-multi.
 * Si usas modo simulado, asegúrate de que runOpenAIorSim / runClaudeorSim / runGeminiorSim
 * NO se llamen cuando no estén en `want`.
 */

// Ejemplo de dependencias ya existentes:
// import express from 'express';
// const app = express();
// app.use(express.json());

app.post('/v1/compare-multi', async (req, res) => {
  const { prompt, providers = [], options = {} } = req.body || {};
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ ok: false, error: 'prompt requerido' });
  }

  // Si el cliente no manda providers, puedes decidir:
  //  - Rechazar (400) o
  //  - Asumir todas (compatibilidad). Aquí asumimos todas PARA NO ROMPER usuarios antiguos.
  const want = (Array.isArray(providers) && providers.length > 0)
    ? new Set(providers)
    : new Set(['openai', 'claude', 'gemini']);

  const out = { ok: true };

  try {
    if (want.has('openai')) {
      out.openai = await runOpenAIorSim(prompt, options);  // Reutiliza tu función actual
    }
    if (want.has('claude')) {
      out.claude = await runClaudeorSim(prompt, options);
    }
    if (want.has('gemini')) {
      out.gemini = await runGeminiorSim(prompt, options);
    }

    return res.json(out);
  } catch (err) {
    console.error('[compare-multi] error:', err);
    return res.status(500).json({ ok: false, error: 'internal', detail: String(err) });
  }
});

// --- Simulaciones (sustituir por providers reales)
async function simulateOpenAI(prompt) {
  return `(OpenAI) Resumen para: ${prompt.slice(0, 120)}… [simulado]`;
}
async function simulateGemini(prompt) {
  return `(Gemini) Respuesta analítica para: ${prompt.slice(0, 120)}… [simulado]`;
}
async function simulateClaude(prompt) {
  return `(Claude) Respuesta estructurada para: ${prompt.slice(0, 120)}… [simulado]`;
}

// --- 404 JSON consistente
app.use((req, res, next) => {
  if (res.headersSent) return next();
  res.status(404).json({ ok: false, error: "Not Found", path: req.originalUrl });
});

// --- Manejador centralizado de errores
app.use((err, req, res, _next) => {
  const status = err.status || 500;
  const payload = {
    ok: false,
    error: err.message || "Internal Server Error",
    code: err.code || "INTERNAL_ERROR",
    request_id: req.id
  };
  console.error(`[ERR ${req.id}]`, err);
  if (!res.headersSent) res.status(status).json(payload);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`API listening on :${PORT}`));
