// src/middleware/authSoft.js
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "change-me";

/**
 * Autenticación NO intrusiva:
 * - Si hay Authorization Bearer válido => rellena req.auth
 * - Si no hay o no es válido => continúa sin tirar 401
 */
export function authSoft(req, _res, next) {
  req.auth = req.auth || null;

  // Admin via header key (dev convenience)
  try {
    const adminKeyHeader = req.headers && (req.headers['x-admin-key'] || req.headers['X-Admin-Key']);
    const ADMIN_KEY = process.env.ADMIN_KEY || "";
    if (adminKeyHeader && ADMIN_KEY && String(adminKeyHeader) === String(ADMIN_KEY)) {
      req.auth = req.auth || {};
      req.auth.role = 'admin';
      req.auth.pro = true; // treat as pro for gating
    }
  } catch {}

  try {
    const auth = req.headers?.authorization || "";
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return next();

    const token = m[1];
    const payload = jwt.verify(token, JWT_SECRET, { ignoreExpiration: false });

    // Convenciones típicas del payload que veníamos usando:
    // { plan: "pro", pro: true, scope: {...}, deviceId, exp, iat, ... }
    const pro =
      payload?.pro === true ||
      String(payload?.plan || "").toLowerCase() === "pro";

    req.auth = {
      ...payload,
      pro,
      userId: payload?.sub || payload?.userId || null,
    };
    return next();
  } catch (_e) {
    // Token inválido/expirado: seguimos sin auth
    return next();
  }
}

// Convenience flags
export function isAdmin(req){ return !!(req.auth && req.auth.role === 'admin'); }
