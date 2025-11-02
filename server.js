import fs from "fs";
import path from "path";
import express from "express";
import cors from "cors";


const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ===== Env =====
const PORT = process.env.PORT || 3000;
const SIMULATE = String(process.env.SIMULATE || "").toLowerCase() === "true";
const FREE_DAILY_LIMIT = Number(process.env.FREE_DAILY_LIMIT || 25);
const RL_DEBUG_SECRET = process.env.RL_DEBUG_SECRET || "";

// ===== Util =====
function todayStr(){ const d=new Date(); const y=d.getUTCFullYear(); const m=String(d.getUTCMonth()+1).padStart(2,"0"); const dd=String(d.getUTCDate()).padStart(2,"0"); return `${y}-${m}-${dd}`; }
function newReqId(){ return (globalThis.crypto?.randomUUID?.()||Math.random().toString(36).slice(2))+"-"+Date.now().toString(36); }

// ===== RL store (memoria) =====
const rlStore = { day: todayStr(), hitsByKey: new Map() };
function rlKeyFromReq(req){ const ip=req.headers["x-forwarded-for"]?.toString().split(",")[0].trim()||req.ip||"local"; return ip; }
function rlResetIfNewDay(){ const t=todayStr(); if(t!==rlStore.day){ rlStore.day=t; rlStore.hitsByKey.clear(); } }

// ===== authSoft =====
function authSoft(req,_res,next){
  req.id=newReqId(); req.state=req.state||{};
  const auth=req.headers.authorization||"";
  req.state.authz=auth;

  const bodyMode = req.body?.mode ? String(req.body.mode).toLowerCase() : undefined;
  const effMode = bodyMode || (SIMULATE ? "sim" : "real");
  req.state.mode = effMode;
  req.simulate = effMode === "sim";

  req.state.isPro = /^Bearer\s+eyJ/.test(auth); // heurístico
  next();
}

// ===== rateLimit =====
function rateLimit(req,res,next){
  rlResetIfNewDay(); req.state=req.state||{};

  const dbg = (req.headers["x-debug-bypass"]||"").toString();
  const bypass = RL_DEBUG_SECRET && dbg && dbg===RL_DEBUG_SECRET;
  if(bypass){ req.state.rateLimitBypassed=true; return next(); }

  const key = rlKeyFromReq(req);
  const used = rlStore.hitsByKey.get(key)||0;
  if(used >= FREE_DAILY_LIMIT){
    return res.status(429).json({ ok:false, error:"rate_limit_exceeded", message:"Límite diario alcanzado", limit:FREE_DAILY_LIMIT, used, key, day:rlStore.day });
  }
  rlStore.hitsByKey.set(key, used+1);
  req.state.rateLimitBypassed=false;
  next();
}

// ===== proGuard =====
function proGuard(req,res,next){
  const mode=req.state?.mode || (SIMULATE?"sim":"real");
  const bypass=!!req.state?.rateLimitBypassed;
  const isPro=!!req.state?.isPro;
  if(mode==="real" && !bypass && !isPro){
    return res.status(402).json({ ok:false, error:"pro_required", message:"Se requiere PRO para modo real (o X-Debug-Bypass en pruebas)." });
  }
  next();
}

// ===== Rutas =====
app.get("/v1/health", (_req,res)=> res.json({ ok:true, tag:"health-v2", simulate: SIMULATE }) );

app.get("/__diag/mw", (req,res)=>{
  rlResetIfNewDay();
  const auth=req.headers.authorization||"";
  const dbg=(req.headers["x-debug-bypass"]||"").toString();
  const bypass = !!(RL_DEBUG_SECRET && dbg && dbg===RL_DEBUG_SECRET);
  res.json({
    ok:true,
    simulate: SIMULATE,
    inferredMode: SIMULATE ? "sim" : "real",
    isPro: /^Bearer\s+eyJ/.test(auth),
    rateLimit:{ day: rlStore.day, limit: FREE_DAILY_LIMIT, used: rlStore.hitsByKey.get(rlKeyFromReq(req))||0, key: rlKeyFromReq(req) },
    rateLimitBypassed: bypass,
    rateLimitKey: bypass ? "debug-header" : rlKeyFromReq(req),
  });
});

// usado por la extensión; aquí no persistimos nada
app.post("/v1/usage/increment", (_req,res)=> res.json({ ok:true }) );

// etiqueta de ruta (opcional)
app.use("/v1/compare-multi", (req,_res,next)=>{ req.routeTag="compare-multi"; next(); });

// === Handler principal ===
// Mantén tu orden de middlewares. Aquí asumo: authSoft → rateLimit → proGuard → handler.

app.post("/v1/compare-multi", authSoft, rateLimit, proGuard, async (req, res) => {
  try {
    const body = req.body || {};
    const prompt = body.prompt || "";
    const selected = Array.isArray(body.selectedIAs)
      ? body.selectedIAs
      : Array.isArray(body.providers)
      ? body.providers
      : ["openai","gemini","claude"];

    const mode = (body.mode || req.state?.mode || (process.env.SIMULATE ? "sim":"real")).toLowerCase();
    const simulate = (req.simulate === true) || mode === "sim";

    if (simulate) {
      const mk = (name) => `[simulado:${name}] Respuesta breve para: "${String(prompt).slice(0,80)}"`;
      return res.json({
        ok: true,
        mode: "sim",
        requestId: req.id || (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)),
        providers: selected,
        openai: selected.includes("openai") ? mk("openai") : "",
        gemini: selected.includes("gemini") ? mk("gemini") : "",
        claude: selected.includes("claude") ? mk("claude") : "",
      });
    }

    return res.json({
      ok: true,
      mode: "real",
      requestId: req.id || (globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)),
      providers: selected,
      openai: selected.includes("openai") ? "[real:openai] (stub)" : "",
      gemini: selected.includes("gemini") ? "[real:gemini] (stub)" : "",
      claude: selected.includes("claude") ? "[real:claude] (stub)" : "",
    });
  } catch (e) {
    console.error("[compare-multi ERR]", e);
    return res.status(500).json({ ok:false, error: e?.message || "internal_error" });
  }
});

app.get("/__whoami", (req, res) => {
  try {
    const cwd = process.cwd();
    const files = fs.readdirSync(cwd).sort();
    let serverJs = "";
    try { serverJs = fs.readFileSync(path.join(cwd, "server.js"), "utf8"); }
    catch (e) { serverJs = `NO server.js at root: ${e.message}`; }

    res.json({
      ok: true,
      cwd,
      files,                              // Archivos del directorio donde arranca node
      hasPlaceholder: /placeholder/.test(serverJs),
      hasSimulado: /\[simulado:/.test(serverJs),
      serverHead: serverJs.slice(0, 180) // Primeras líneas para reconocer versión
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===== Start =====
app.listen(PORT, ()=> console.log(`[server] :${PORT} simulate=${SIMULATE} limit=${FREE_DAILY_LIMIT}`) );
