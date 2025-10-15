// src/middleware/proGuard.js

function hasUserProviders(req) {
  const h = req.headers && (req.headers["x-user-providers"] || req.headers["X-User-Providers"]);
  if (!h) return false;
  // cualquier valor no vacío sirve; si quieres, valida lista
  return String(h).trim().length > 0;
}

/**
 * Si la petición pide `mode: "real"` pero el usuario NO tiene PRO
 * ni trae X-User-Providers, forzamos `mode: "simulated"`.
 * (No rompe si body no existe.)
 */
export function proGuard(req, _res, next) {
  const body = req.body || {};
  // Admin allows real always
  if (req?.auth?.role === 'admin') { return next(); }
  const wantsReal = String(body?.mode || "").toLowerCase() === "real";
  const isPro = !!req.auth?.pro;
  const userHasKeys = hasUserProviders(req);

  if (wantsReal && !(isPro || userHasKeys)) {
    body.mode = "simulated";
    req.body = body;
  }
  next();
}

// Export util por si te hace falta en otras piezas (rate-limit)
export function requestHasRealPower(req) {
  const body = req.body || {};
  // Admin allows real always
  if (req?.auth?.role === 'admin') { return next(); }
  const wantsReal = String(body?.mode || "").toLowerCase() === "real";
  const isPro = !!req.auth?.pro;
  const userHasKeys = hasUserProviders(req);
  return wantsReal && (isPro || userHasKeys);
}
