// Rate limit muy simple en memoria (token+ip)
// Producción real: usa Redis si necesitas persistencia entre instancias.
const buckets = new Map();

const {
  RATE_LIMIT_WINDOW_MS = "60000",
  RATE_LIMIT_MAX = "60",
} = process.env;

export function rateLimitReal(req, res, next) {
  const windowMs = parseInt(RATE_LIMIT_WINDOW_MS, 10);
  const max = parseInt(RATE_LIMIT_MAX, 10);

  const ip = req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || req.ip || "ip";
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "") || "no-token";
  const key = `${token}:${ip}`;

  const now = Date.now();
  const bucket = buckets.get(key) || { count: 0, reset: now + windowMs };

  if (now > bucket.reset) {
    bucket.count = 0;
    bucket.reset = now + windowMs;
  }

  bucket.count += 1;
  buckets.set(key, bucket);

  if (bucket.count > max) {
    const retrySecs = Math.ceil((bucket.reset - now) / 1000);
    return res.status(429).json({
      ok: false,
      code: "RATE_LIMITED",
      retryAfter: retrySecs,
      message: "Has alcanzado el límite temporal de uso en Modo Real. Inténtalo más tarde.",
    });
  }

  next();
}
