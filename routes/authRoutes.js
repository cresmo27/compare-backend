import express from "express";
import { signProToken } from "../utils/jwt.js";
import { hmacHex } from "../utils/hmac.js";

const router = express.Router();

const {
  ALLOWLIST_KEYS = "",              // plano: MIC-PRO-AAAA,...
  ALLOWLIST_HASHED_KEYS = "",       // hmac sha256 hex, separado por comas
  DEVICE_MAX = "3",
} = process.env;

const allowPlain = new Set(
  ALLOWLIST_KEYS.split(",").map(s => s.trim()).filter(Boolean)
);
const allowHmac = new Set(
  ALLOWLIST_HASHED_KEYS.split(",").map(s => s.trim().toLowerCase()).filter(Boolean)
);

// Activación: valida clave (plano o HMAC) y emite JWT Pro (30d)
router.post("/activate", (req, res) => {
  const { key, deviceId } = req.body || {};
  if (!key) return res.status(400).json({ ok: false, code: "NO_KEY" });

  // 1) plano
  let valid = allowPlain.has(key);

  // 2) hmac
  if (!valid) {
    const hx = hmacHex(key).toLowerCase();
    if (allowHmac.has(hx)) valid = true;
  }

  if (!valid) {
    return res.status(400).json({ ok: false, code: "INVALID_KEY" });
  }

  // licenseId derivada de la propia clave (no sensible)
  const licenseId = "lic_" + hmacHex(key).slice(0, 16);
  const token = signProToken({ licenseId, deviceId }, { expiresIn: "30d" });
  const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();

  return res.json({
    ok: true,
    token,
    plan: "pro",
    scope: ["pro", "neutral:real"],
    expiresAt,
    devicesMax: parseInt(DEVICE_MAX, 10),
  });
});

// Status: requiere token; devuelve plan/caducidad (lectura base del JWT sin validar exp dura)
router.get("/status", (req, res) => {
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ ok: false, code: "NO_TOKEN" });

  try {
    const base64 = token.split(".")[1];
    const json = Buffer.from(base64, "base64url").toString("utf8");
    const payload = JSON.parse(json || "{}");

    return res.json({
      ok: true,
      plan: payload?.plan || "pro",
      scope: payload?.scope || [],
      licenseId: payload?.licenseId,
      deviceId: payload?.deviceId,
    });
  } catch (e) {
    return res.status(401).json({ ok: false, code: "INVALID_TOKEN" });
  }
});

export default router;
