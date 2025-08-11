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
  GEMINI_MODEL = "gemini-2.5-flash-lite",
  SUMMARY_PROVIDER = "gemini",
  MAX_TOKENS_OUT = "250",
  TEMP = "0.3"
} = process.env;

const maxOut = parseInt(MAX_TOKENS_OUT, 10) || 250;
const temperature = Number(TEMP) || 0.3;

/** -------- Helpers por proveedor (con límites de coste) -------- **/
async function askOpenAI(prompt) {
  if (!OPENAI_API_KEY) throw new Error("Falta OPENAI_API_KEY");
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input: prompt,
      max_output_tokens: maxOut,
      temperature
    })
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status} ${await res.text()}`);
  const data = await res.json();
  const text = data.output_text ?? (data.output?.[0]?.content?.[0]?.text ?? "");
  return text;
}

async function askGemini(prompt) {
  if (!GEMINI_API_KEY) throw new Error("Falta GEMINI_API_KEY");
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }]}],
      generationConfig: { maxOutputTokens: maxOut, temperature }
    })
  });
  if (!res.ok) throw new Error(`Gemini ${res.status} ${await res.text()}`);
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join("\n") ?? "";
  return text || JSON.stringify(data);
}

/** -------- Endpoint principal -------- **/
app.post("/compare", async (req, res) => {
  try {
    const { prompt, providers = { openai: true, gemini: true }, doSummary = false } = req.body || {};
    if (!prompt) return res.status(400).json({ error: "Falta 'prompt'" });

    const results = [];
    const tasks = [];

    if (providers.openai) {
      tasks.push(
        askOpenAI(prompt)
          .then(text => results.push({ provider: "OpenAI", text }))
          .catch(err => results.push({ provider: "OpenAI", error: String(err.message || err) }))
      );
    }
    if (providers.gemini) {
      tasks.push(
        askGemini(prompt)
          .then(text => results.push({ provider: "Gemini", text }))
          .catch(err => results.push({ provider: "Gemini", error: String(err.message || err) }))
      );
    }

    await Promise.all(tasks);

    let summary = "";
    if (doSummary && results.length) {
      const joined = results.map(r => `### ${r.provider}\n${r.text || r.error || ""}`).join("\n\n");
      const sumPrompt = `Resume en 3 viñetas (máx 80 palabras) las coincidencias y diferencias de estos textos, neutro y conciso.\n\n${joined}`;
      try {
        if (SUMMARY_PROVIDER.toLowerCase() === "gemini") {
          summary = await askGemini(sumPrompt);
        } else {
          summary = await askOpenAI(sumPrompt);
        }
      } catch {
        summary = "No se pudo generar resumen.";
      }
    }

    res.json({ results, summary });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/health", (_, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`✅ compare-backend (low-cost) en http://localhost:${PORT}`));
