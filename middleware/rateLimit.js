// src/middleware/rateLimit.js
import { requestHasRealPower } from "./proGuard.js";

/**
 * Límite gratis diario (por deviceId o IP). Se ignora cuando:
 * - body.mode === "real"  Y
 * - (req.auth.pro === true  O  header 'X-User-Providers' no vacío)
 *
 * Config:
 *   FREE_DAILY_LIMIT=9   (por defecto 9)
 */
const FREE_DAILY_LIMIT = Number(process.env.FREE_DAILY_LIMIT || 9);

// memoria (simple) con expiración diaria
const buckets = new Map(); // key -> { count, resetAt }

function todayResetAt() {
  // resetea a las 00:00:00 del día siguiente (UTC)
  const now = new Date();
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0));
  return reset.getTime();
}

function keyFromReq(req) {
  const dev = req.headers["x-device-id"] || req.headers["X-Device-Id"];
  // si no hay deviceId, usamos ip (Render suele poner x-forwarded-for)
  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";
  return String(dev || ip || "unknown");
}

export function rateLimit(req, res, next) {
  // ⛳️ BYPASS: REAL con PRO o claves propias
  if (requestHasRealPower(req)) {
    return next();
  }

  const key = keyFromReq(req);
  const now = Date.now();
  if (req?.auth?.role === 'admin') return next();
  let b = buckets.get(key);

  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: todayResetAt() };
    buckets.set(key, b);
  }

  if (b.count >= FREE_DAILY_LIMIT) {
    return res.status(429).json({
      ok: false,
      code: "LIMIT_REACHED",
      message: "Límite diario alcanzado (servidor)",
      resetAt: b.resetAt,
      freeDailyLimit: FREE_DAILY_LIMIT,
    });
  }

  b.count += 1;
  next();
}
