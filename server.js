// server.js — Multi-IA Compare backend (OpenAI / Claude / Gemini)
// Rutas:
//   GET  /v1/health
//   POST /v1/compare-multi  { prompt, models:["openai","claude","gemini"], temperature }
//   POST /v1/compare        { prompt, model, temperature }
// Vars de entorno (Render): OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY
// CORS_ORIGIN="*" para pruebas. FREE_DAILY_LIMIT ajustable.
// Nota: limitador diario simple en memoria (se reinicia al redeploy).

import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;
const ORIGIN = process.env.CORS_ORIGIN || '*';
const FREE_DAILY_LIMIT = parseInt(process.env.FREE_DAILY_LIMIT || '3', 10);

app.use(cors({ origin: ORIGIN, credentials: false }));
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

/* -------------------- Limitador diario simple (por instalación) -------------------- */
const buckets = new Map(); // installId -> { count, resetAt }
function nextUtcMidnightTs() {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0); // resetea a medianoche UTC
  return d.getTime();
}
function consumePoint(installId) {
  if (!installId) return { remaining: 0, limited: true };
  const now = Date.now();
  const b = buckets.get(installId);
  if (!b || now > b.resetAt) {
    buckets.set(installId, { count: 1, resetAt: nextUtcMidnightTs() });
    return { remaining: Math.max(0, FREE_DAILY_LIMIT - 1) };
  }
  if (b.count >= FREE_DAILY_LIMIT) return { remaining: 0, limited: true };
  b.count += 1;
  return { remaining: Math.max(0, FREE_DAILY_LIMIT - b.count) };
}
function getRemaining(installId) {
  const b = buckets.get(installId);
  return b ? Math.max(0, FREE_DAILY_LIMIT - b.count) : FREE_DAILY_LIMIT;
}
function getInstallId(req) {
  return (req.headers['x-install-id'] || '').toString();
}

/* ----------------------------------- Rutas ----------------------------------- */

// Salud
app.get('/v1/health', (_req, res) => res.json({ ok: true }));

// Comparativa MULTI
app.post('/v1/compare-multi', async (req, res) => {
  const installId = getInstallId(req);
  if (!installId) return res.status(400).json({ error: 'Missing X-Install-ID header' });

  const limit = consumePoint(installId);
  if (limit.limited) return res.status(429).json({ error: 'Free daily limit reached', quota: { remaining: 0 } });

  const { prompt, models, temperature } = req.body || {};
  if (!prompt || !Array.isArray(models) || models.length === 0) {
    return res.status(400).json({ error: 'prompt and models[] required' });
  }

  try {
    const tasks = models.map(async (m) => {
      switch (m) {
        case 'openai':
          return ['openai', await callOpenAI(prompt, temperature)];
        case 'claude':
          return ['claude', await callClaude(prompt, temperature)];
        case 'gemini':
          return ['gemini', await callGemini(prompt, temperature)];
        default:
          return [m, '(modelo desconocido)'];
      }
    });

    const entries = await Promise.all(tasks);
    const outputs = Object.fromEntries(entries);
    return res.json({ outputs, quota: { remaining: getRemaining(installId) } });
  } catch (err) {
    console.error(err);
    return res.status(500).send('Server error');
  }
});

// Comparativa SINGLE
app.post('/v1/compare', async (req, res) => {
  const installId = getInstallId(req);
  if (!installId) return res.status(400).json({ error: 'Missing X-Install-ID header' });

  const limit = consumePoint(installId);
  if (limit.limited) return res.status(429).json({ error: 'Free daily limit reached', quota: { remaining: 0 } });

  const { prompt, model, temperature } = req.body || {};
  if (!prompt || !model) return res.status(400).json({ error: 'prompt and model required' });

  try {
    let out = '';
    if (model === 'openai') out = await callOpenAI(prompt, temperature);
    else if (model === 'claude') out = await callClaude(prompt, temperature);
    else if (model === 'gemini') out = await callGemini(prompt, temperature);
    else return res.status(400).json({ error: 'unknown model' });

    return res.json({ output: out, quota: { remaining: getRemaining(installId) } });
  } catch (err) {
    console.error(err);
    return res.status(500).send('Server error');
  }
});

/* ------------------------------ Llamadas IA ------------------------------ */

async function callOpenAI(prompt, temperature = 1) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set');

  const body = {
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: Number.isFinite(+temperature) ? +temperature : 1
  };

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) throw new Error(`OpenAI error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callClaude(prompt, temperature = 1) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');

  const body = {
    model: 'claude-3-haiku-20240307',
    max_tokens: 512,
    temperature: Number.isFinite(+temperature) ? +temperature : 1,
    messages: [{ role: 'user', content: prompt }]
  };

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  if (!resp.ok) throw new Error(`Anthropic error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data.content?.[0]?.text || '';
}

async function callGemini(prompt, temperature = 1) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error('GOOGLE_API_KEY not set');

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: Number.isFinite(+temperature) ? +temperature : 1 }
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) throw new Error(`Gemini error ${resp.status}: ${await resp.text()}`);
  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

/* --------------------------------- Start --------------------------------- */
app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});
