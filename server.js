// src/server.js
import express from "express";
import cors from "cors";

// ===== Config básica =====
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ===== Env =====
const PORT = process.env.PORT || 3000;
const SIMULATE = String(process.env.SIMULATE || "").toLowerCase() === "true";  // sim global
const FREE_DAILY_LIMIT = Number(process.env.FREE_DAILY_LIMIT || 25);           // cupo gratis
const RL_DEBUG_SECRET = process.env.RL_DEBUG_SECRET || "";                     // bypass cabecera

// ===== Utiles =====
function todayStr() {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}
function newReqId() {
  return (
    (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)) +
    "-" +
    Date.now().toString(36)
  );
}

// ===== Estado rate-limit (en memoria, por IP + día) =====
const rlStore = {
  day: todayStr(),
  hitsByKey: new Map(), // key => count
};
function rlKeyFromReq(req) {
  // Puedes ajustar: por IP + user-agent
  const ip = req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() || req.ip || "local";
  return `${ip}`;
}
function rlResetIfNewDay() {
  const t = todayStr();
  if (t !== rlStore.day) {
    rlStore.day = t;
    rlStore.hitsByKey.clear();
  }
}

// ===== authSoft =====
// - No bloquea. Lee Authorization si viene.
// - Determina "mode" (sim/real): prioridad body.mode > env SIMULATE.
function authSoft(req, _res, next) {
  req.id = newReqId();
  req.state = req.state || {};

  const auth = req.headers.authorization || "";
  req.state.authz = auth;

  const bodyMode = (req.body && req.body.mode) ? String(req.body.mode).toLowerCase() : undefined;
  const effMode = bodyMode || (SIMULATE ? "sim" : "real");
  req.state.mode = effMode;           // "sim" | "real"
  req.simulate = effMode === "sim";   // atajo

  // "isPro": si traes un Bearer con pinta de JWT (eyJ...) lo damos por PRO a efectos de ejemplo
  const isJwt = /^Bearer\s+eyJ/.test(auth);
  req.state.isPro = isJwt;

  next();
}

// ===== rateLimit =====
// - Bypass si viene X-Debug-Bypass igual a RL_DEBUG_SECRET.
// - Si no, aplica FREE_DAILY_LIMIT por IP/día.
function rateLimit(req, res, next) {
  rlResetIfNewDay();
  req.state = req.state || {};

  const dbgHeader = (req.headers["x-debug-bypass"] || "").toString();
  const hasBypass = RL_DEBUG_SECRET && dbgHeader && dbgHeader === RL_DEBUG_SECRET;

  if (hasBypass) {
    req.state.rateLimitBypassed = true;
    return next();
  }

  const key = rlKeyFromReq(req);
  const used = rlStore.hitsByKey.get(key) || 0;

  if (used >= FREE_DAILY_LIMIT) {
    return res.status(429).json({
      ok: false,
      error: "rate_limit_exceeded",
      message: "Límite diario alcanzado",
      limit: FREE_DAILY_LIMIT,
      used,
      key,
      day: rlStore.day,
    });
  }

  rlStore.hitsByKey.set(key, used + 1);
  req.state.rateLimitBypassed = false;
  next();
}

// ===== proGuard =====
// - Si modo "real" y NO hay bypass y NO hay PRO => bloquea.
// - Si modo "sim" o hay PRO o hay bypass => pasa.
function proGuard(req, res, next) {
  const mode = req.state?.mode || (SIMULATE ? "sim" : "real");
  const bypass = !!req.state?.rateLimitBypassed;
  const isPro = !!req.state?.isPro;

  if (mode === "real" && !bypass && !isPro) {
    return res.status(402).json({
      ok: false,
      error: "pro_required",
      message: "Se requiere cuenta PRO para modo real (o usar X-Debug-Bypass durante pruebas).",
    });
  }
  next();
}

// ===== Salud =====
app.get("/v1/health", (_req, res) => {
  res.json({ ok: true, tag: "health", simulate: SIMULATE });
});

// ===== Diagnóstico de cadena de middlewares =====
app.get("/__diag/mw", (req, res) => {
  const bodyMode = (req.query && req.query.mode) ? String(req.query.mode).toLowerCase() : undefined;
  const mode = bodyMode || (SIMULATE ? "sim" : "real");
  // "isPro" heurístico (no pasamos authSoft aquí, así que solo inferimos por cabecera presente)
  const auth = req.headers.authorization || "";
  const isJwt = /^Bearer\s+eyJ/.test(auth);
  const dbgHeader = (req.headers["x-debug-bypass"] || "").toString();
  const bypass = !!(RL_DEBUG_SECRET && dbgHeader && dbgHeader === RL_DEBUG_SECRET);

  // Estado RL actual
  rlResetIfNewDay();
  const key = rlKeyFromReq(req);
  const used = rlStore.hitsByKey.get(key) || 0;

  res.json({
    ok: true,
    simulate: SIMULATE,
    inferredMode: mode,
    isPro: isJwt,
    rateLimit: {
      day: rlStore.day,
      limit: FREE_DAILY_LIMIT,
      used,
      key,
    },
    rateLimitBypassed: bypass,
    rateLimitKey: bypass ? "debug-header" : key,
  });
});

// ===== Stub para /v1/usage/increment (lo usa la extensión; aquí no hacemos nada) =====
app.post("/v1/usage/increment", (req, res) => {
  // Recibimos: { deviceId, requestId, increments, date, tz }
  // Para pruebas, devolvemos ok sin persistir.
  res.json({ ok: true });
});

// ===== compare-multi =====
// Orden: authSoft → rateLimit → proGuard → handler
app.use("/v1/compare-multi", (req, _res, next) => {
  req.routeTag = "compare-multi";
  next();
});

app.post("/v1/compare-multi", authSoft, rateLimit, proGuard, async (req, res) => {
  try {
    const body = req.body || {};
    const prompt = body.prompt || "";
    const selected = Array.isArray(body.selectedIAs)
      ? body.selectedIAs
      : Array.isArray(body.providers)
      ? body.providers
      : ["openai", "gemini", "claude"];

    const simulate = req.simulate === true; // decidido por authSoft (body.mode/env)

    if (simulate) {
      const mk = (name) =>
        `[simulado:${name}] Respuesta breve para: "${String(prompt).slice(0, 80)}"`;
      const out = {
        ok: true,
        mode: "sim",
        requestId: req.id,
        providers: selected,
        openai: selected.includes("openai") ? mk("openai") : "",
        gemini: selected.includes("gemini") ? mk("gemini") : "",
        claude: selected.includes("claude") ? mk("claude") : "",
      };
      return res.json(out);
    }

    // REAL (aquí pondrías tus llamadas reales; por ahora devolvemos stub compatible)
    return res.json({
      ok: true,
      mode: "real",
      requestId: req.id,
      providers: selected,
      info: "compare-multi real: proveedor pendiente (stub)",
      openai: selected.includes("openai") ? "[real:openai] (stub)" : "",
      gemini: selected.includes("gemini") ? "[real:gemini] (stub)" : "",
      claude: selected.includes("claude") ? "[real:claude] (stub)" : "",
    });
  } catch (e) {
    console.error(`[compare-multi ERR ${req.id}]`, e);
    return res
      .status(500)
      .json({ ok: false, error: e?.message || "internal_error" });
  }
});

// ===== Start =====
app.listen(PORT, () => {
  console.log(`[server] listening on :${PORT} — simulate=${SIMULATE} — limit=${FREE_DAILY_LIMIT}`);
});
