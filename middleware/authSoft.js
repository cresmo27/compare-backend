// src/middleware/authSoft.js
import jwt from "jsonwebtoken";

/**
 * Autenticación suave + contrato de estado para el resto de middlewares.
 * NO lanza 401. Rellena req.state con:
 *   - mode: 'real' | 'sim'
 *   - userId: string
 *   - isPro: boolean
 *   - hasKeys: boolean
 *   - providers: string[]
 */
export function authSoft(req, _res, next) {
  // Asegura body y estado
  req.body = req.body || {};
  req.state = req.state || {};

  // ---- MODO ----
  const bodyMode = (typeof req.body.mode === "string" ? req.body.mode : "").toLowerCase();
  req.state.mode = bodyMode === "real" ? "real" : "sim";
  // Refleja en body por compatibilidad con handlers existentes
  req.body.mode = req.state.mode;

  // ---- JWT (decodificación sin verificación, intencional: "soft") ----
  const auth = req.headers["authorization"] || "";
  let payload = null;
  if (auth && auth.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    try {
      // decode sin verificar firma: suficiente para tier/userId "soft"
      payload = jwt.decode(token) || null;
    } catch {
      payload = null;
    }
  }

  // ---- userId ----
  const xfwd = req.headers["x-forwarded-for"];
  const ip = Array.isArray(xfwd)
    ? xfwd[0]
    : (xfwd ? String(xfwd).split(",")[0].trim() : (req.socket?.remoteAddress || "0.0.0.0"));
  const userIdFromJwt = payload?.sub || payload?.user_id || payload?.uid || null;
  req.state.userId = userIdFromJwt || `anon:${ip}`;

  // ---- isPro ----
  const tier = (payload?.tier || payload?.plan || payload?.role || "").toString().toLowerCase();
  const isProClaim = tier.includes("pro") || payload?.isPro === true || payload?.pro === true || payload?.premium === true;
  // También permitimos cabecera explícita (ej. para pruebas)
  const xTier = (req.headers["x-user-tier"] || "").toString().toLowerCase();
  const isProHeader = xTier.includes("pro");
  req.state.isPro = Boolean(isProClaim || isProHeader);

  // ---- providers / hasKeys ----
  const headerProv = req.headers["x-user-providers"] || req.headers["x-providers"] || "";
  let providers = Array.isArray(headerProv) ? headerProv.join(",") : String(headerProv || "");
  providers = providers
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const xHasKeys = req.headers["x-has-keys"];
  const hasKeysHeader = typeof xHasKeys === "string"
    ? ["1", "true", "yes"].includes(xHasKeys.toLowerCase())
    : Boolean(xHasKeys);
  const hasKeysJwt = Boolean(payload && ((Array.isArray(payload.providers) && payload.providers.length > 0) || payload.hasKeys === true));
  req.state.providers = providers;
  req.state.hasKeys = Boolean(hasKeysHeader || providers.length > 0 || hasKeysJwt);

  // ---- Log compacto ----
  const pv = providers.length ? `[${providers.join(",")}]` : "[]";
  console.log(`authSoft> mode=${req.state.mode} userId=${req.state.userId} isPro=${Number(req.state.isPro)} hasKeys=${Number(req.state.hasKeys)} providers=${pv}`);

  return next();
}
