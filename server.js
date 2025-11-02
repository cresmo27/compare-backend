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

// ===== utilidades varias/ids =====
function rid() {
  return crypto.randomBytes(6).toString("hex");
}

// ===== App =====
const app = express();
app.disable?.("x-powered-by");

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// id de request + simulación global
app.use((req, _res, next) => {
  req.id = req.id || rid();
  // SIMULATE global para pruebas
  req.simulate = String(process.env.SIMULATE || "").toLowerCase() === "true";
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

// ---------- Diagnóstico middlewares ----------
// Evalúa estado tal como lo verían los middlewares, sin consumir rate-limit.
app.get("/__diag/mw", authSoft, (req, res) => {
  try {
    // Reaprovechamos la misma lógica de cabecera/whitelist que usa rateLimit,
    // pero sin incrementar contadores.
    const st = req.state || {};
    const DEBUG_SECRET = process.env.RL_DEBUG_SECRET || "";
    const DEBUG_WHITELIST = (process.env.RL_DEBUG_WHITELIST || "")
      .split(",").map(s => s.trim()).filter(Boolean);

    const dbgHeader = req.get("X-Debug-Bypass");
    const userId = st.userId || req.user?.sub || req.user?.id || req.user?.email || null;

    let rateLimitBypassed = false;
    let rateLimitKey = null;
    let remaining = null;

    if (DEBUG_SECRET && dbgHeader && dbgHeader === DEBUG_SECRET) {
      rateLimitBypassed = true;
      rateLimitKey = "debug-header";
    } else if (userId && DEBUG_WHITELIST.includes(String(userId))) {
      rateLimitBypassed = true;
      rateLimitKey = `whitelist:${userId}`;
    } else if (st.mode === "real" && (st.isPro || st.hasKeys)) {
      rateLimitBypassed = true;
      rateLimitKey = st.isPro ? "real+pro" : "real+keys";
    } else {
      // Simular cuál sería la clave y el restante sin consumirla
      const userKey = st.userId || `anon:${req.ip || "0.0.0.0"}`;
      const dayKey = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      rateLimitKey = `${dayKey}:${userKey}`;
      // No tocamos el store real, por eso remaining va null
      remaining = null;
    }

    return res.json({
      mode: st.mode,
      simulate: !!req.simulate,
      isPro: !!st.isPro,
      hasKeys: !!st.hasKeys,
      rateLimitBypassed,
      rateLimitKey,
      remaining
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error: e?.message || "diag_error" });
  }
});

// ---------- Auth (v1) ----------
app.use("/v1/auth", authRoutes);

// ---------- compare-multi ----------
// Orden: authSoft → rateLimit → proGuard → handler
app.use("/v1/compare-multi", (req, _res, next) => {
  // Marcado de ruta para logs
  req.routeTag = "compare-multi";
  next();
});
app.post("/v1/compare-multi", authSoft, rateLimit, proGuard, async (req, res) => {
  try {
    const body = req.body || {};
    const prompt = body.prompt || "";
    const temperature = typeof body.temperature === "number" ? body.temperature : 0.3;
    const providers = Array.isArray(body.providers) ? body.providers : [];
    const mode = body.mode || req.state?.mode || "sim";

    // ejemplo de respuesta compacta
    return res.json({
      ok: true,
      mode,
      providers,
      requestId: req.id,
      sim: !!req.simulate,
      info: "compare-multi placeholder (mantiene compatibilidad)"
    });
  } catch (e) {
    console.error(`[compare-multi ERR ${req.id}]`, e);
    return res.status(500).json({ ok: false, error: e?.message || "internal_error" });
  }
});

// ---------- analyze-neutral ----------
app.post("/v1/analyze-neutral", authSoft, rateLimit, proGuard, async (req, res) => {
  try {
    const { inputs, options } = req.body || {};
    if (!Array.isArray(inputs) || inputs.length < 2) {
      return res.status(400).json({ ok: false, error: "need_2_plus_inputs" });
    }
    // placeholder de análisis neutral
    return res.json({
      ok: true,
      requestId: req.id,
      result: {
        summary: "Análisis neutral (placeholder)",
        differences: [],
        overlaps: []
      }
    });
  } catch (e) {
    console.error(`[analyze-neutral ERR ${req.id}]`, e);
    return res.status(500).json({ ok: false, error: e?.message || "internal_error" });
  }
});

// =========================================================
// ===============  Espejo de uso (igual) ==================
// =========================================================

const usageStore = new Map();
app.post("/v1/usage/increment", (req, res) => {
  try {
    const { deviceId, requestId, increments, date } = req.body || {};
    if (!deviceId || !requestId || !date || typeof increments !== "object")
      return res.status(400).json({ ok: false, error: "bad_request" });

    const key = `${date}:${deviceId}`;
    const prev = usageStore.get(key) || { total: 0, byReq: {} };
    prev.total += 1;
    prev.byReq[requestId] = (prev.byReq[requestId] || 0) + 1;
    usageStore.set(key, prev);

    return res.json({ ok: true, key, total: prev.total, byReq: prev.byReq[requestId] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "internal_error" });
  }
});

// ---------- 404 y errores ----------
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
