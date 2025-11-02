import { verifyToken } from "../utils/jwt.js";

export function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.replace(/^Bearer\s+/i, "");

  if (!token) {
    return res.status(401).json({ ok: false, code: "NO_TOKEN" });
  }
  const { ok, decoded, error } = verifyToken(token);
  if (!ok) {
    return res.status(401).json({ ok: false, code: "INVALID_TOKEN", error });
  }
  req.user = decoded;
  next();
}
