import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const {
  PORT = 8080,
  OPENAI_API_KEY,
  OPENAI_MODEL = "gpt-4o-mini",
  GEMINI_API_KEY,
  GEMINI_MODEL = "gemini-2.5-flash"
} = process.env;

if (!OPENAI_API_KEY) console.warn("⚠️ Falta OPENAI_API_KEY");
if (!GEMINI_API_KEY) console.warn("⚠️ Falta GEMINI_API_KEY");

async function askOpenAI(prompt) {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ model: OPENAI_MODEL, input: prompt })
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status} ${await res.text()}`);
  const data = await res.json();
  const text = data.output_text ?? (data.output?.[0]?.content?.[0]?.text ?? "");
  return text;
}

async function askGemini(prompt) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }]}] })
  });
  if (!res.ok) throw new Error(`Gemini ${res.status} ${await res.text()}`);
  const data = await res.json();
  const text = (data?.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n");
  return text;
}

app.post("/compare", async (req, res) => {
  try {
    const { prompt, providers = { openai: true, gemini: true } } = req.body || {};
    if (!prompt) return res.status(400).json({ error: "Falta 'prompt'" });

    const tasks = [];
    if (providers.openai) tasks.push(askOpenAI(prompt).then(text => ({ provider: "OpenAI", text })));
    if (providers.gemini) tasks.push(askGemini(prompt).then(text => ({ provider: "Gemini", text })));

    const results = await Promise.all(tasks);

    let summary = "";
    try {
      if (providers.openai) {
        const joined = results.map(r => `### ${r.provider}\n${r.text}`).join("\n\n");
        summary = await askOpenAI(`Resume en 3 viñetas las coincidencias y diferencias entre estos textos:\n\n${joined}`);
      }
    } catch (e) {
      summary = "No se pudo generar resumen automático.";
    }

    res.json({ results, summary });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/health", (_, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`✅ compare-backend escuchando en http://localhost:${PORT}`));
