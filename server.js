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

// --- ENDPOINT UNIFICADO: compara 3 IAs (simulado)
// Contrato: POST { prompt: string } → { ok, openai, gemini, claude }
app.post("/v1/compare-multi", async (req, res, next) => {
  try {
    const { prompt } = req.body || {};
    if (typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({ ok: false, code: "BAD_PROMPT", error: "Falta 'prompt' válido." });
    }
    if (prompt.length > 8000) {
      return res.status(413).json({ ok: false, code: "PROMPT_TOO_LARGE", error: "Prompt demasiado largo." });
    }

    // Simulación (sustituir por llamadas reales cuando toque)
    const [openai, gemini, claude] = await Promise.all([
      simulateOpenAI(prompt),
      simulateGemini(prompt),
      simulateClaude(prompt),
    ]);

    res.json({ ok: true, openai, gemini, claude });
  } catch (err) {
    next(err);
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
