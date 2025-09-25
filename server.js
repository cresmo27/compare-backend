// server.js — v1.11.0 secure baseline
import express from "express";
import cors from "cors";

// ------- Config (env) -------
const PORT = process.env.PORT || 3000;
const API_GATEWAY_SECRET = process.env.API_GATEWAY_SECRET || ""; // <-- PONLO EN RENDER
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
const RATE_LIMIT_PER_MIN = Number(process.env.RATE_LIMIT_PER_MIN || 30);

// Modelos por defecto
const DEFAULT_MODELS = {
  openai: "gpt-4o-mini",
  claude: "claude-3-haiku-20240307",
  gemini: "gemini-1.5-flash",
};
const PROVIDERS = ["openai","claude","gemini"];
const pickModel = (p, m)=> (m && String(m).trim()) || DEFAULT_MODELS[p];
const now = ()=> (typeof performance!=="undefined" && performance.now)? performance.now() : Date.now();

// ------- App -------
const app = express();

// CORS (restringible por env)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  // Permisivo en dev con "*", restrictivo si pones lista de orígenes
  const allowAll = ALLOWED_ORIGINS.includes("*");
  const allowed = allowAll || (origin && ALLOWED_ORIGINS.includes(origin));

  if (allowed && origin) {
    res.header("Access-Control-Allow-Origin", origin);
  } else if (allowAll) {
    res.header("Access-Control-Allow-Origin", "*");
  }
  res.header("Vary", "Origin");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: "1mb" }));

// ------- Helpers -------
const httpError = (res, code, msg, extra={}) =>
  res.status(code).json({ ok:false, code, error:msg, ...extra });

// Auth middleware (excepto /v1/health)
app.use((req, res, next) => {
  if (req.path === "/v1/health") return next();
  if (!API_GATEWAY_SECRET) {
    // En dev: si no hay secreto, advertimos y dejamos pasar.
    return next();
  }
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || token !== API_GATEWAY_SECRET) {
    return httpError(res, 401, "unauthorized: missing/invalid gateway token");
  }
  next();
});

// Rate limiting por IP (muy simple)
const bucket = new Map(); // ip -> [timestamps(ms)]
function rateLimit(req, res, next) {
  if (RATE_LIMIT_PER_MIN <= 0) return next();
  const ip = req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() || req.ip || "unknown";
  const nowMs = Date.now();
  const windowMs = 60 * 1000;
  const arr = (bucket.get(ip) || []).filter(t => nowMs - t < windowMs);
  arr.push(nowMs);
  bucket.set(ip, arr);
  if (arr.length > RATE_LIMIT_PER_MIN) {
    return httpError(res, 429, "rate_limited: too many requests");
  }
  next();
}
app.use("/v1", rateLimit);

// ------- Proveedores -------
async function callOpenAI({ prompt, model, temperature=0.2, signal }){
  const apiKey = process.env.OPENAI_API_KEY;
  if(!apiKey) throw new Error("OPENAI_API_KEY no configurada");
  const res = await fetch("https://api.openai.com/v1/chat/completions",{
    method:"POST",
    headers:{ Authorization:`Bearer ${apiKey}`, "Content-Type":"application/json" },
    body: JSON.stringify({ model, temperature, messages:[{role:"user",content:prompt}] }),
    signal
  });
  if(!res.ok){ const text = await res.text().catch(()=> ""); throw new Error(`OpenAI ${res.status}: ${text}`); }
  const data = await res.json();
  return { output: data?.choices?.[0]?.message?.content ?? "" };
}

async function callAnthropic({ prompt, model, temperature=0.2, signal }){
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if(!apiKey) throw new Error("ANTHROPIC_API_KEY no configurada");
  const res = await fetch("https://api.anthropic.com/v1/messages",{
    method:"POST",
    headers:{ "x-api-key":apiKey, "anthropic-version":"2023-06-01", "Content-Type":"application/json" },
    body: JSON.stringify({ model, max_tokens:1024, temperature, messages:[{role:"user",content:prompt}] }),
    signal
  });
  if(!res.ok){ const text = await res.text().catch(()=> ""); throw new Error(`Anthropic ${res.status}: ${text}`); }
  const data = await res.json();
  const output = Array.isArray(data?.content) ? data.content.map(b => b?.text || "").join("\n") : "";
  return { output };
}

async function callGemini({ prompt, model, temperature=0.2, signal }){
  const apiKey = process.env.GEMINI_API_KEY;
  if(!apiKey) throw new Error("GEMINI_API_KEY no configurada");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url,{
    method:"POST", headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ contents:[{role:"user", parts:[{text:prompt}]}], generationConfig:{ temperature, maxOutputTokens:1024 } }),
    signal
  });
  if(!res.ok){ const text = await res.text().catch(()=> ""); throw new Error(`Gemini ${res.status}: ${text}`); }
  const data = await res.json();
  const output = data?.candidates?.[0]?.content?.parts?.map(p=>p?.text||"").join("\n") ?? "";
  return { output };
}

async function callProvider({ provider, prompt, model, temperature, signal }){
  const p = provider.toLowerCase();
  if(p==="openai") return callOpenAI({ prompt, model, temperature, signal });
  if(p==="claude") return callAnthropic({ prompt, model, temperature, signal });
  if(p==="gemini") return callGemini({ prompt, model, temperature, signal });
  throw new Error(`Proveedor no soportado: ${provider}`);
}

// ------- Rutas -------
app.get("/v1/health", (_req,res)=> res.json({ ok:true, tag:"health-v1" }));

app.post("/v1/compare", async (req,res)=>{
  try{
    const { provider, prompt, model, temperature } = req.body || {};
    if(!provider || !PROVIDERS.includes(String(provider).toLowerCase())) return httpError(res,400,"bad_request: provider inválido");
    if(!prompt || typeof prompt!=="string") return httpError(res,400,"bad_request: prompt requerido");
    const mdl = pickModel(String(provider).toLowerCase(), model);
    const temp = typeof temperature==="number" ? temperature : 0.2;
    const ctrl = new AbortController(); const t0 = now();
    const r = await callProvider({ provider, prompt, model: mdl, temperature: temp, signal: ctrl.signal });
    return res.json({ ok:true, provider:String(provider).toLowerCase(), model:mdl, latencyMs: Math.round(now()-t0), output: r.output });
  }catch(e){
    // Errores consistentes
    const msg = String(e?.message||e);
    const code = /401|unauthorized/i.test(msg) ? 401
              : /403|forbidden/i.test(msg) ? 403
              : /429|rate/i.test(msg) ? 429
              : 502;
    return httpError(res, code, msg);
  }
});

// Streaming solo OpenAI
app.post("/v1/compare-stream", async (req,res)=>{
  try{
    const { provider, prompt, model, temperature } = req.body || {};
    if(String(provider).toLowerCase()!=="openai") return httpError(res,400,"bad_request: Solo provider=openai en streaming");
    if(!prompt || typeof prompt!=="string") return httpError(res,400,"bad_request: prompt requerido");
    const apiKey = process.env.OPENAI_API_KEY; if(!apiKey) return httpError(res,500,"OPENAI_API_KEY no configurada");

    const mdl = pickModel("openai", model);
    const temp = typeof temperature==="number"? temperature: 0.2;

    res.setHeader("Content-Type","text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control","no-cache, no-transform");
    res.setHeader("Connection","keep-alive");
    res.flushHeaders?.();

    const send = (event,data)=> res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const t0 = now();
    send("begin",{ model: mdl });

    const upstream = await fetch("https://api.openai.com/v1/chat/completions",{
      method:"POST",
      headers:{ Authorization:`Bearer ${apiKey}`, "Content-Type":"application/json" },
      body: JSON.stringify({ model: mdl, temperature: temp, stream:true, messages:[{role:"user",content:prompt}] })
    });

    if(!upstream.ok || !upstream.body){
      const text=await upstream.text().catch(()=> "");
      send("error",{ error:`OpenAI ${upstream.status}: ${text}` });
      return res.end();
    }

    const reader = upstream.body.getReader(); const decoder = new TextDecoder("utf-8"); let buffer="";
    while(true){
      const { value, done } = await reader.read(); if(done) break;
      buffer += decoder.decode(value, { stream:true });
      let idx; while((idx = buffer.indexOf("\n")) >= 0){
        const line = buffer.slice(0, idx).trim(); buffer = buffer.slice(idx+1);
        if(!line) continue;
        if(line.startsWith("data: ")){
          const data = line.slice(6);
          if(data === "[DONE]"){ send("done",{ latencyMs: Math.round(now()-t0) }); return res.end(); }
          try{
            const json = JSON.parse(data);
            const delta = json?.choices?.[0]?.delta?.content || "";
            if(delta) send("delta",{ text: delta });
          }catch{}
        }
      }
    }
    send("done",{ latencyMs: Math.round(now()-t0) }); res.end();
  }catch(e){
    try{ res.write(`event: error\ndata: ${JSON.stringify({ error:String(e?.message||e) })}\n\n`);}catch{}
    res.end();
  }
});

app.use((_req,res)=> httpError(res,404,"not_found: Ruta no encontrada"));

app.listen(PORT, ()=> console.log("Backend secure v1.11.0 en :"+PORT));
