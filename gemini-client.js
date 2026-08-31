/*
 * Gemini generateContent client (main process).
 *
 * Ported from IRIS_Electron/src/server/aggregation/gemini-provider.js — calls the
 * Google GenAI REST API with Node's built-in `fetch` (no Python, no SDK). This
 * replaces the pipeline.py subprocess for Red List summary generation.
 *
 *   POST {apiBase}/v1beta/models/{model}:generateContent?key={key}
 *   body: { contents: [{ parts: [{ text }] }], generationConfig: { responseMimeType: 'application/json' } }
 */

const DEFAULT_API_BASE = "https://generativelanguage.googleapis.com";

async function postWithTimeout(url, init, timeoutMs, signal) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener("abort", () => ctl.abort(), { once: true });
  }
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Generate content from a prompt; returns the model's text output. We request
// JSON mode so the Red List caller can parse the response into sections.
async function generateJson({ apiKey, model, apiBase, prompt, timeoutMs, signal }) {
  if (!apiKey) throw new Error("No Gemini API key set. Add it in Settings.");
  const base = String(apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
  const url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const res = await postWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" },
    }),
  }, timeoutMs || 300000, signal);

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Gemini ${res.status}: ${detail.slice(0, 300)}`);
  }

  const data = await res.json();
  const cand = data && data.candidates && data.candidates[0];
  const parts = cand && cand.content && cand.content.parts;
  const text = Array.isArray(parts) ? parts.map(p => p.text || "").join("").trim() : "";
  if (!text) throw new Error("Gemini returned no text content.");
  return text;
}

module.exports = { generateJson, DEFAULT_API_BASE };
