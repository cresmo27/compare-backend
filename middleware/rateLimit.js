// src/middleware/rateLimit.js

// Límite diario SOLO para usuarios Simulados (no PRO y sin claves) o para modo 'sim'.
// Bypass explícito cuando: mode === 'real' && (isPro || hasKeys).
// Añadido: bypass de pruebas por cabecera secreta (X-Debug-Bypass) y/o lista blanca por userId/sub/email.
const LIMIT_FREE_PER_DAY = parseInt(process.env.FREE_DAILY_LIMIT || "25", 10);

const DEBUG_SECRET = process.env.RL_DEBUG_SECRET || "";
const DEBUG_WHITELIST = (process.env.RL_DEBUG_WHITELIST || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// Almacenamiento en memoria por día (suficiente para Render free/low tier)
const store = new Map();

export function rateLimit(req, res, next) {
  const st = req.state || {};
  req.rateLimitBypassed = false;
  req.rateLimitKey = null;
  req.rateLimitRemaining = null;

  // --- BYPASS DE PRUEBAS (header secreto y/o whitelist) ---
  try {
    const dbgHeader = req.get?.("X-Debug-Bypass");
    const userId = st.userId || req.user?.sub || req.user?.id || req.user?.email || null;

    // 1) Header secreto
    if (DEBUG_SECRET && dbgHeader && dbgHeader === DEBUG_SECRET) {
      req.rateLimitBypassed = true;
      req.rateLimitKey = "debug-header";
      console.log("rateLimit> bypass=1 reason=debug-header");
      return next();
    }

    // 2) Lista blanca por userId/sub/email
    if (userId && DEBUG_WHITELIST.includes(String(userId))) {
      req.rateLimitBypassed = true;
      req.rateLimitKey = `whitelist:${userId}`;
      console.log(`rateLimit> bypass=1 reason=whitelist user=${userId}`);
      return next();
    }
  } catch (_e) {
    // No rompe el flujo si algo va raro con los headers
  }

  // --- BYPASS NORMAL (modo real con PRO o con claves) ---
  const bypass = st.mode === "real" && (st.isPro || st.hasKeys);
  if (bypass) {
    const reason = st.isPro ? "real+pro" : "real+keys";
    req.rateLimitBypassed = true;
    req.rateLimitKey = reason;
    console.log(`rateLimit> bypass=1 reason=${reason}`);
    return next();
  }

  // --- LÍMITE DIARIO PARA FREE / SIM ---
  // Clave de usuario (protegida para anónimos)
  const userKey = st.userId || `anon:${req.ip || "0.0.0.0"}`;
  const dayKey = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const key = `${dayKey}:${userKey}`;

  const count = (store.get(key) || 0) + 1;
  store.set(key, count);

  req.rateLimitKey = key;
  req.rateLimitRemaining = Math.max(0, LIMIT_FREE_PER_DAY - count);

  console.log(`rateLimit> bypass=0 key=${key} count=${count}/${LIMIT_FREE_PER_DAY}`);

  if (count > LIMIT_FREE_PER_DAY) {
    return res.status(429).json({ ok: false, error: "Límite diario alcanzado" });
  }

  return next();
}

// Tarea de limpieza: purga claves de días anteriores cada hora
setInterval(() => {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  for (const k of store.keys()) if (!k.startsWith(`${today}:`)) store.delete(k);
}, 60 * 60 * 1000).unref?.();
