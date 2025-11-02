// src/middleware/rateLimit.js

// Límite diario SOLO para usuarios Simulados (no PRO y sin claves) o para modo 'sim'.
// Bypass explícito cuando: mode === 'real' && (isPro || hasKeys).
const LIMIT_FREE_PER_DAY = parseInt(process.env.FREE_DAILY_LIMIT || "25", 10);

// Almacenamiento en memoria por día (suficiente para Render free/low tier)
const store = new Map();

export function rateLimit(req, res, next) {
  const st = req.state || {};
  const bypass = st.mode === "real" && (st.isPro || st.hasKeys);

  if (bypass) {
    const reason = st.isPro ? "real+pro" : "real+keys";
    console.log(`rateLimit> bypass=1 reason=${reason}`);
    return next();
  }

  // Clave de usuario (protegida para anónimos)
  const userKey = st.userId || `anon:${req.ip || "0.0.0.0"}`;
  const dayKey = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const key = `${dayKey}:${userKey}`;

  const count = (store.get(key) || 0) + 1;
  store.set(key, count);

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
