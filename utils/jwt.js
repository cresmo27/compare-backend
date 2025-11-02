// ESM
import jwt from "jsonwebtoken";

const { JWT_SECRET = "dev_jwt_secret" } = process.env;

export function signProToken(payload = {}, opts = {}) {
  const base = {
    scope: ["pro", "neutral:real"],
    plan: "pro",
  };
  const merged = { ...base, ...payload };
  const expiresIn = opts.expiresIn || "30d";
  return jwt.sign(merged, JWT_SECRET, { algorithm: "HS256", expiresIn });
}

export function verifyToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] });
    return { ok: true, decoded };
  } catch (err) {
    return { ok: false, error: err?.message || "INVALID_TOKEN" };
  }
}
