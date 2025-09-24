import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import { RateLimiterMemory } from 'rate-limiter-flexible';

dotenv.config();
const app = express();
const PORT = process.env.PORT || 10000;
const ORIGIN = process.env.CORS_ORIGIN || '*';
const FREE_DAILY_LIMIT = parseInt(process.env.FREE_DAILY_LIMIT || '3', 10);

app.use(cors({ origin: ORIGIN, credentials: false }));
app.use(express.json({ limit: '1mb' }));
app.use(morgan('tiny'));

const limiter = new RateLimiterMemory({
  points: FREE_DAILY_LIMIT,
  duration: 60 * 60 * 24,
  keyPrefix: 'freeTier'
});

function getInstallId(req) {
  return (req.headers['x-install-id'] || '').toString();
}

app.get('/v1/health', (req, res) => res.json({ ok: true }));

app.post('/v1/compare-multi', async (req, res) => {
  try {
    const installId = getInstallId(req);
    if (!installId) return res.status(400).json({ error: 'Missing X-Install-ID header' });
    try { await limiter.consume(installId, 1); }
    catch { return res.status(429).json({ error: 'Free daily limit reached', quota: { remaining: 0 } }); }

    const { prompt, models, temperature } = req.body || {};
    if (!prompt || !Array.isArray(models) || models.length === 0) {
      return res.status(400).json({ error: 'prompt and models[] required' });
    }

    const tasks = models.map(async (m) => {
      switch (m) {
        case 'openai': return ['openai', await callOpenAI(prompt, temperature)];
        case 'claude': return ['claude', await callClaude(prompt, temperature)];
        case 'gemini': return ['gemini', await callGemini(prompt, temperature)];
        default: return [m, '(modelo desconocido)'];
      }
    });

    const entries = await Promise.all(tasks);
    const outputs = Object.fromEntries(entries);

    const rl = await limiter.get(installId);
    const remaining = Math.max(0, (rl && rl.remainingPoints) ?? 0);

    res.json({ outputs, quota: { remaining } });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// (Opcional) Single model endpoint
app.post('/v1/compare', async (req, res) => {
  try {
    const installId = getInstallId(req);
    if (!installId) return res.status(400).json({ error: 'Missing X-Install-ID header' });
    try { await limiter.consume(installId, 1); }
    catch { return res.status(429).json({ error: 'Free daily limit reached', quota: { remaining: 0 } }); }

    const { prompt, model, temperature } = req.body || {};
    if (!prompt || !model) return res.status(400).json({ error: 'prompt and model required' });

    let out = '';
    switch (model) {
      case 'openai': out = await callOpenAI(prompt, temperature); break;
      case 'claude': out = await callClaude(prompt, temperature); break;
      case 'gemini': out = await callGemini(prompt, temperature); break;
      default: return res.status(400).json({ error: 'unknown model' });
    }

    const rl = await limiter.get(installId);
    const remaining = Math.max(0, (rl && rl.remainingPoints) ?? 0);
    res.json({ output: out, quota: { remaining } });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

async function callOpenAI(prompt, temperature=1) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set');
  const body = {
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: Number.isFinite(+temperature) ? +temperature : 1
  };
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) { throw new Error(`OpenAI error ${resp.status}: ${await resp.text()}`); }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '';
}

async function callClaude(prompt, temperature=1) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  const body = {
    model: "claude-3-haiku-20240307",
    max_tokens: 512,
    temperature: Number.isFinite(+temperature) ? +temperature : 1,
    messages: [{ role: "user", content: prompt }]
  };
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!resp.ok) { throw new Error(`Anthropic error ${resp.status}: ${await resp.text()}`); }
  const data = await resp.json();
  return data.content?.[0]?.text || '';
}

async function callGemini(prompt, temperature=1) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error('GOOGLE_API_KEY not set');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`;
  const body = { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: Number.isFinite(+temperature) ? +temperature : 1 } };
  const resp = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!resp.ok) { throw new Error(`Gemini error ${resp.status}: ${await resp.text()}`); }
  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

app.listen(PORT, () => console.log(`API listening on http://localhost:${PORT}`));
