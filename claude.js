// claude.js
export async function askClaude(prompt, maxTokens) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_MODEL || "claude-3-5-sonnet-latest",
      max_tokens: Number(maxTokens || process.env.ANTHROPIC_MAX_TOKENS || 512),
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Claude API ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  const text = Array.isArray(data?.content)
    ? data.content.map(c => c?.text || "").join("\n")
    : "";

  return { provider: "claude", model: data?.model, text };
}
