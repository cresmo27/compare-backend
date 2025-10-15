import { verifyToken } from "../utils/jwt.js";
import { rateLimitReal } from "./rateLimit.js";

const { DEVICE_MAX = "3" } = process.env;

// Pequeño registro en memoria para "device binding" (v1.13, sin DB)
const licenseDevices = new Map(); // licenseId -> Set(deviceId)

function allowByUserProvidedKeys(req) {
  // La extensión mandará este header si el usuario usa SUS claves locales
  // Ej: 'openai' o 'openai,claude'
  const hdr = req.headers["x-user-providers"];
  return typeof hdr === "string" && hdr.trim().length > 0;
}

function tokenAllowsReal(decoded) {
  const scope = decoded?.scope || [];
  return Array.isArray(scope) && (scope.includes("pro") || scope.includes("neutral:real"));
}

function deviceAllowed(decoded, deviceId) {
  if (!decoded?.licenseId || !deviceId) return true; // si no hay licenseId, no aplicamos
  const max = parseInt(DEVICE_MAX, 10);
  const set = licenseDevices.get(decoded.licenseId) || new Set();
  if (!set.has(deviceId) && set.size >= max) {
    return false;
  }
  // registrar
  if (!set.has(deviceId)) {
    set.add(deviceId);
    licenseDevices.set(decoded.licenseId, set);
  }
  return true;
}

// Middleware principal para proteger "mode: real" en /v1/compare-multi
export function realModeGuard(req, res, next) {
  if (req.method !== "POST") return next();

  const requestedMode = (req.body?.mode || "").toLowerCase();

  if (requestedMode !== "real") {
    return next();
  }

  // 1) ¿El usuario trae sus propias claves?
  if (allowByUserProvidedKeys(req)) {
    return rateLimitReal(req, res, next);
  }

  // 2) Exigir JWT Pro
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "");

  if (!token) {
    req.body.mode = "simulated";
    req._forcedSimulated = true;
    return next();
  }

  const { ok, decoded } = verifyToken(token);
  if (!ok || !tokenAllowsReal(decoded)) {
    req.body.mode = "simulated";
    req._forcedSimulated = true;
    return next();
  }

  const deviceId = req.headers["x-device-id"]?.toString();
  if (!deviceAllowed(decoded, deviceId)) {
    return res.status(409).json({
      ok: false,
      code: "DEVICE_LIMIT",
      message: "Se alcanzó el número máximo de dispositivos para esta licencia.",
    });
  }

  return rateLimitReal(req, res, next);
}
