// server.js
// Backend ligero para Comparador de IAs
// Proveedores: openai, claude, gemini. + Streaming SSE para OpenAI

import express from "express";
import cors from "cors";

// Node 18+ trae fetch y AbortController nativos.

const app = express();

// ---------- Middlewares ----------
app.use(cors({ origin: true }));
app.options("*", cors()); // responde preflight CORS
app.use(express.json({ limit: "1mb" }));

// ---------- Utilidades ----------
const PROVIDERS = ["openai", "claude", "gemini"];

const DEFAULT_MODELS = {
  openai: "gpt-4o-mini",
  claude: "claude-3-haiku-20240307",
  gemini: "gemini-1.5-flash",
};

function pickModel(provider, requested) {
  if (requested && typeof requested === "string" && requested.trim()) return requested.trim();
  return DEFAULT_MODELS[provider];
}

function getNowMs() {
  return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
}

function httpError(res, code, message, extra = {}) {
  return res.status(code).json({ ok: false, error: message, ...extra });
}

async function withTimeout(promise, ms, abortController) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => {
      try { abortController?.abort?.(); } catch {}
      reject(new Error(`timeout after ${ms}ms`));
    }, ms)
  );
  return Promise.race([promise, timeout]);
}

// ---------- Proveedores ----------
async function callOpenAI({ prompt, model, temperature = 0.2, signal }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY no configurada");

  const url = "https://api.openai.com/v1/chat/completions";
  const body = {
    model: model || DEFAULT_MODELS.openai,
    messages: [{ role: "user", content: prompt }],
    temperature,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`OpenAI ${res.status}: ${text}`);
  }

  const data = await res.json();
  const message = data?.choices?.[0]?.message?.content ?? "";
  const usage = data?.usage ?? null;

  return { output: message, usage };
}

async function callAnthropic({ prompt, model, temperature = 0.2, signal }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY no configurada");

  const url = "https://api.anthropic.com/v1/messages";
  const body = {
    model: model || DEFAULT_MODELS.claude,
    max_tokens: 1024,
    temperature,
    messages: [{ role: "user", content: prompt }],
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Anthropic ${res.status}: ${text}`);
  }

  const data = await res.json();
  const output =
    Array.isArray(data?.content)
      ? data.content.map((b) => (typeof b?.text === "string" ? b.text : "")).join("\n")
      : "";

  return { output, usage: data?.usage ?? null };
}

async function callGemini({ prompt, model, temperature = 0.2, signal }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY no configurada");

  const mdl = model || DEFAULT_MODELS.gemini;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    mdl
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature, maxOutputTokens: 1024 },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gemini ${res.status}: ${text}`);
  }

  const data = await res.json();
  const output =
    data?.candidates?.[0]?.content?.parts
      ?.map((p) => (typeof p?.text === "string" ? p.text : ""))
      .join("\n") ?? "";

  return { output, usage: data?.usageMetadata ?? null };
}

async function callProvider({ provider, prompt, model, temperature, signal }) {
  const p = provider.toLowerCase();
  if (p === "openai") return callOpenAI({ prompt, model, temperature, signal });
  if (p === "claude") return callAnthropic({ prompt, model, temperature, signal });
  if (p === "gemini") return callGemini({ prompt, model, temperature, signal });
  throw new Error(`Proveedor no soportado: ${provider}`);
}

// ---------- Rutas de salud ----------
app.get("/", (_req, res) => res.json({ ok: true, tag: "root" }));
app.get("/health", (_req, res) => res.json({ ok: true, tag: "health" }));
app.get("/v1/health", (_req, res) => res.json({ ok: true, tag: "health-v1" }));

// ---------- Debug: listar rutas ----------
app.get("/v1/debug-routes", (_req, res) => {
  const routes = [];
  app._router.stack.forEach((middleware) => {
    if (middleware.route) {
      const methods = Object.keys(middleware.route.methods)
        .filter((m) => middleware.route.methods[m])
        .map((m) => m.toUpperCase());
      routes.push({ methods, path: middleware.route.path });
    } else if (middleware.name === "router" && middleware.handle.stack) {
      middleware.handle.stack.forEach((handler) => {
        if (handler.route) {
          const methods = Object.keys(handler.route.methods)
            .filter((m) => handler.route.methods[m])
            .map((m) => m.toUpperCase());
          routes.push({ methods, path: handler.route.path });
        }
      });
    }
  });
  res.json({ ok: true, routes });
});

// ---------- /v1/compare ----------
app.post("/v1/compare", async (req, res) => {
  try {
    const { provider, prompt, model, temperature } = req.body || {};
    if (!provider || !PROVIDERS.includes(String(provider).toLowerCase())) {
      return httpError(res, 400, `provider inválido. Usa: ${PROVIDERS.join(", ")}`);
    }
    if (!prompt || typeof prompt !== "string") {
      return httpError(res, 400, "prompt requerido (string)");
    }

    const selectedModel = pickModel(String(provider).toLowerCase(), model);
    const temp = typeof temperature === "number" ? temperature : 0.2;

    const controller = new AbortController();
    const t0 = getNowMs();

    try {
      const result = await withTimeout(
        callProvider({ provider, prompt, model: selectedModel, temperature: temp, signal: controller.signal }),
        30000,
        controller
      );

      const latencyMs = Math.round(getNowMs() - t0);
      return res.json({
        ok: true,
        provider: String(provider).toLowerCase(),
        model: selectedModel,
        latencyMs,
        output: result.output,
        usage: result.usage ?? null,
      });
    } catch (err) {
      return httpError(res, 502, `Error llamando a ${provider}: ${(err && err.message) || err}`);
    }
  } catch (e) {
    return httpError(res, 500, "Error interno en /v1/compare", { detail: String(e?.message || e) });
  }
});

// ---------- /v1/compare-multi ----------
app.post("/v1/compare-multi", async (req, res) => {
  try {
    const { providers, prompt, perProviderOptions } = req.body || {};

    if (!Array.isArray(providers) || providers.length === 0) {
      return httpError(res, 400, "providers requerido (array con al menos un proveedor)");
    }
    const normalized = providers.map((p) => String(p).toLowerCase()).filter((p) => PROVIDERS.includes(p));
    if (normalized.length === 0) {
      return httpError(res, 400, `providers inválidos. Soportados: ${PROVIDERS.join(", ")}`);
    }
    if (!prompt || typeof prompt !== "string") {
      return httpError(res, 400, "prompt requerido (string)");
    }

    const t0 = getNowMs();

    const tasks = normalized.map(async (p) => {
      const opts = (perProviderOptions && perProviderOptions[p]) || {};
      const model = pickModel(p, opts.model);
      const temperature = typeof opts.temperature === "number" ? opts.temperature : 0.2;

      const controller = new AbortController();
      const timeoutMs = p === "gemini" ? 45000 : 35000;

      const pStart = getNowMs();
      try {
        const result = await withTimeout(
          callProvider({ provider: p, prompt, model, temperature, signal: controller.signal }),
          timeoutMs,
          controller
        );
        return {
          ok: true,
          provider: p,
          model,
          latencyMs: Math.round(getNowMs() - pStart),
          output: result.output,
          usage: result.usage ?? null,
        };
      } catch (err) {
        return {
          ok: false,
          provider: p,
          model,
          latencyMs: Math.round(getNowMs() - pStart),
          error: (err && err.message) || String(err),
        };
      }
    });

    const results = await Promise.all(tasks);
    const totalMs = Math.round(getNowMs() - t0);

    return res.json({ ok: true, totalLatencyMs: totalMs, results });
  } catch (e) {
    return httpError(res, 500, "Error interno en /v1/compare-multi", { detail: String(e?.message || e) });
  }
});

// ---------- STREAMING OpenAI: /v1/compare-stream ----------
/**
 * POST /v1/compare-stream
 * Body: { provider: "openai", prompt: string, model?: string, temperature?: number }
 * Respuesta SSE con eventos:
 *   event: begin   data: {"model":"..."}
 *   event: delta   data: {"text":"..."}
 *   event: done    data: {"latencyMs":1234}
 *   event: error   data: {"error":"..."}
 */
app.post("/v1/compare-stream", async (req, res) => {
  try {
    const { provider, prompt, model, temperature } = req.body || {};
    if (String(provider).toLowerCase() !== "openai") {
      return httpError(res, 400, "Solo soportado: provider=openai en streaming");
    }
    if (!prompt || typeof prompt !== "string") {
      return httpError(res, 400, "prompt requerido (string)");
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return httpError(res, 500, "OPENAI_API_KEY no configurada");

    const mdl = pickModel("openai", model);
    const temp = typeof temperature === "number" ? temperature : 0.2;

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    const t0 = getNowMs();
    send("begin", { model: mdl });

    const url = "https://api.openai.com/v1/chat/completions";
    const body = {
      model: mdl,
      temperature: temp,
      stream: true,
      messages: [{ role: "user", content: prompt }],
    };

    const controller = new AbortController();

    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      send("error", { error: `OpenAI ${upstream.status}: ${text}` });
      return res.end();
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        if (line.startsWith("data: ")) {
          const data = line.slice(6);
          if (data === "[DONE]") {
            const latencyMs = Math.round(getNowMs() - t0);
            send("done", { latencyMs });
            return res.end();
          }
          try {
            const json = JSON.parse(data);
            const delta = json?.choices?.[0]?.delta?.content || "";
            if (delta) send("delta", { text: delta });
          } catch {
            // ignora líneas no JSON
          }
        }
      }
    }

    const latencyMs = Math.round(getNowMs() - t0);
    send("done", { latencyMs });
    res.end();
  } catch (e) {
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ error: String(e?.message || e) })}\n\n`);
    } catch {}
    res.end();
  }
});

// ---------- 404 y manejador de errores ----------
app.use((_req, res) => httpError(res, 404, "Ruta no encontrada"));
app.use((err, _req, res, _next) => httpError(res, 500, "Error no controlado", { detail: String(err?.message || err) }));

// ---------- Inicio ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Compare backend escuchando en :${PORT}`);
});
