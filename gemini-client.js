/*
 * Gemini generateContent client (main process).
 *
 * Ported from IRIS_Electron/src/server/aggregation/gemini-provider.js — calls the
 * Google GenAI REST API with Node's built-in `fetch` (no Python, no SDK). This
 * replaces the pipeline.py subprocess for Red List summary generation, and is
 * also the transport for vouchervision-emulator/ (OCR + parsing calls).
 *
 *   POST {apiBase}/{apiVersion}/models/{model}:generateContent?key={key}
 *   body: { contents: [{ parts }], generationConfig, safetySettings }
 */

const DEFAULT_API_BASE    = "https://generativelanguage.googleapis.com";
const DEFAULT_API_VERSION = "v1beta";

// HTTP statuses that will not succeed on retry (mirrors OCR_Gemini._is_fatal_api_error:
// PERMISSION_DENIED / NOT_FOUND / INVALID_ARGUMENT / UNAUTHENTICATED). 429 is retried
// here — the emulator runs several images concurrently against a single key.
const FATAL_STATUSES = new Set([400, 401, 403, 404]);

async function postWithTimeout(url, init, timeoutMs, signal) {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, timeoutMs);
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener("abort", () => ctl.abort(), { once: true });
  }
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } catch (err) {
    if (timedOut) {
      const e = new Error(`Gemini request timed out after ${Math.round(timeoutMs / 1000)}s`);
      e.code = "ETIMEDOUT";
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); }, { once: true });
});

// Low-level generateContent. `parts` is the Gemini parts array (text and/or
// inlineData). Returns { text, usage, raw }. Retries transient failures with
// exponential backoff (2**attempt + jitter seconds, like OCR_Gemini.exponential_backoff).
async function generateContent({
  apiKey, model, apiBase, apiVersion, parts, generationConfig, safetySettings,
  timeoutMs, signal, maxAttempts = 3,
}) {
  if (!apiKey) throw new Error("No Gemini API key set. Add it in Settings.");
  if (!model)  throw new Error("No Gemini model specified.");
  const base = String(apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
  const ver  = apiVersion || DEFAULT_API_VERSION;
  const url  = `${base}/${ver}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const body = { contents: [{ parts }] };
  if (generationConfig) body.generationConfig = generationConfig;
  if (safetySettings)   body.safetySettings   = safetySettings;
  const payload = JSON.stringify(body);

  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal && signal.aborted) throw new Error("aborted");
    try {
      const res = await postWithTimeout(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      }, timeoutMs || 300000, signal);

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        const err = new Error(`Gemini ${res.status}: ${detail.slice(0, 300)}`);
        err.status = res.status;
        throw err;
      }

      const data = await res.json();
      const cand = data && data.candidates && data.candidates[0];
      const cparts = cand && cand.content && cand.content.parts;
      // Skip thought parts (returned when includeThoughts is set) — keep only answer text.
      const text = Array.isArray(cparts)
        ? cparts.filter(p => !p.thought).map(p => p.text || "").join("").trim()
        : "";
      if (!text) {
        const reason = (cand && cand.finishReason) || (data.promptFeedback && data.promptFeedback.blockReason) || "unknown";
        throw new Error(`Gemini returned no text content (finishReason: ${reason}).`);
      }
      const um = data.usageMetadata || {};
      return {
        text,
        usage: {
          promptTokens:   um.promptTokenCount     || 0,
          outputTokens:   um.candidatesTokenCount || 0,
          thinkingTokens: um.thoughtsTokenCount   || 0,
          totalTokens:    um.totalTokenCount      || 0,
        },
        raw: data,
      };
    } catch (err) {
      lastErr = err;
      if ((signal && signal.aborted) || err.message === "aborted") throw err;
      if (err.status && FATAL_STATUSES.has(err.status)) throw err;
      if (attempt === maxAttempts - 1) break;
      await sleep((2 ** attempt + Math.random()) * 1000, signal);
    }
  }
  throw lastErr;
}

// Generate content from a text prompt in JSON mode; returns the model's text
// output. Used by the Red List summary caller.
async function generateJson({ apiKey, model, apiBase, prompt, timeoutMs, signal }) {
  const { text } = await generateContent({
    apiKey, model, apiBase, timeoutMs, signal,
    parts: [{ text: prompt }],
    generationConfig: { responseMimeType: "application/json" },
    maxAttempts: 1,
  });
  return text;
}

// Map a Gemini failure to a user-facing message (wording from the former
// pipeline.py / voucher_pipeline.py). Pass `filename` for per-image messages
// (transcription); omit it for Red List summaries.
function friendlyGeminiError(err, { model, filename } = {}) {
  const raw    = String((err && err.message) || err || "");
  const lower  = raw.toLowerCase();
  const status = (err && err.status) || 0;
  const m      = model || "the selected model";
  const has    = (re) => re.test(raw);

  if (status === 429 || has(/RESOURCE_EXHAUSTED/)) {
    return filename
      ? `Quota exceeded for ${filename} — ${m} requires billing enabled on your Google account. Go to aistudio.google.com to enable billing.`
      : `Quota exceeded — ${m} requires billing enabled. Go to aistudio.google.com to enable billing.`;
  }
  if (status === 401 || status === 403 || has(/UNAUTHENTICATED|PERMISSION_DENIED|API_KEY_INVALID|API key not valid/i)) {
    return filename
      ? `Invalid API key for ${filename} — check your Gemini API key in Settings.`
      : "Invalid API key — check your Gemini API key in Settings.";
  }
  if (status === 404 || has(/NOT_FOUND/)) {
    return filename
      ? `Model not available for ${filename} — check your API key has access to ${m}.`
      : `Model not available — check your API key has access to ${m}.`;
  }
  if (status === 504 || (err && err.code === "ETIMEDOUT") || has(/DEADLINE_EXCEEDED/)) {
    return filename
      ? `Timeout processing ${filename} — image may be too large. Try a smaller image.`
      : "Request timed out — try again or reduce the number of specimens.";
  }
  if (status === 500 || has(/INTERNAL/)) {
    return filename
      ? `Gemini server error for ${filename} — please try again in a moment.`
      : "Gemini server error — please try again in a moment.";
  }
  if (status === 503 || has(/UNAVAILABLE|ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN/) ||
      lower.includes("fetch failed") || lower.includes("network") || lower.includes("connection")) {
    return filename
      ? `Could not reach Gemini for ${filename} — please check your internet connection and try again.`
      : "Could not reach Gemini — please check your internet connection and try again.";
  }
  return filename ? `Failed ${filename}: ${raw.slice(0, 120)}` : `Gemini API error: ${raw.slice(0, 150)}`;
}

module.exports = { generateContent, generateJson, friendlyGeminiError, DEFAULT_API_BASE, DEFAULT_API_VERSION };
