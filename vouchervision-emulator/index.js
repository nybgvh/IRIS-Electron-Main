/*
 * VoucherVision emulator — produces a VoucherVisionGO `/process`-shaped response
 * from two direct Gemini calls (OCR, then parsing) using IRIS's own Gemini key.
 *
 *   const { processImage } = require("./vouchervision-emulator");
 *   const response = await processImage({ bytes, filename, mimeType }, cfg, signal);
 *
 * Response key order follows VoucherVisionGO app.py process_image_request
 * (see README.md for what is and is not emulated).
 */

const { prepareImage }        = require("./image");
const { runOcr }              = require("./ocr");
const { runParse }            = require("./parse");
const { sanitizeForStorage, sanitizeExcelRecord } = require("./sanitize");
const { createLimiter, passthrough } = require("./limiter");

const HOST_NAME       = "IRIS-VoucherVision-Emulator";
const DEFAULT_MODEL   = "gemini-3.1-pro-preview";
const DEFAULT_PROMPT  = "SLTPvM_full.yaml";
const THINKING_LEVELS = new Set(["low", "medium", "high"]);

function thinkingLevel(v) {
  const s = String(v || "low").trim().toLowerCase();
  if (!THINKING_LEVELS.has(s)) throw new Error(`Invalid thinking level "${v}" (allowed: low, medium, high).`);
  return s;
}

function toList(v) {
  if (Array.isArray(v)) return v.map(s => String(s).trim()).filter(Boolean);
  return String(v || "").split(",").map(s => s.trim()).filter(Boolean);
}

// cfg: { apiKey, apiBase?, apiVersion?, engines (array|csv), llmModel, prompt,
//        ocrThinkingLevel?, llmThinkingLevel?, ocrOnly?, notebookMode?, timeoutMs?, maxRetries?,
//        prepLimit?, geminiLimit? }
// `bytes` may be a Buffer or a function returning one (read lazily inside the
// prep limiter so a large batch does not load every file up front).
// prepLimit / geminiLimit are createLimiter() instances shared across a batch:
// prepLimit gates the CPU-bound resize, geminiLimit gates each Gemini call.
async function processImage({ bytes, filename, mimeType }, cfg, signal) {
  if (!cfg || !cfg.apiKey) throw new Error("No Gemini API key set. Add it in Settings.");
  const engines      = toList(cfg.engines).length ? toList(cfg.engines) : [DEFAULT_MODEL];
  const llmModel     = String(cfg.llmModel || "").trim() || DEFAULT_MODEL;
  const promptName   = cfg.prompt || DEFAULT_PROMPT;
  const notebookMode = !!cfg.notebookMode;
  const ocrOnly      = notebookMode || !!cfg.ocrOnly; // notebook mode forces ocr_only (VVGO)
  const ocrLevel     = thinkingLevel(cfg.ocrThinkingLevel);
  const llmLevel     = thinkingLevel(cfg.llmThinkingLevel);
  const gemini = {
    apiKey: cfg.apiKey,
    apiBase: cfg.apiBase,
    apiVersion: cfg.apiVersion,
    timeoutMs: cfg.timeoutMs,
    maxAttempts: (cfg.maxRetries == null ? 2 : Number(cfg.maxRetries)) + 1,
    limit: cfg.geminiLimit || passthrough,
  };
  const prepLimit = cfg.prepLimit || passthrough;

  // VVGO: ocr_prompt_option = verbatim_notebook | verbatim_with_annotations | None(-> default)
  const promptOption = notebookMode ? "verbatim_notebook" : (ocrOnly ? "verbatim_with_annotations" : null);

  const t0 = Date.now();
  const image = await prepLimit(async () => {
    if (signal && signal.aborted) throw new Error("aborted");
    const data = typeof bytes === "function" ? await bytes() : bytes;
    return prepareImage(data, mimeType);
  });
  const tPrep = Date.now();
  const { ocrInfo, ocrAll, promptKey } = await runOcr({
    image, engines, promptOption, thinkingLevel: ocrLevel, gemini, signal,
  });
  const tOcr = Date.now();

  // Sanitized copies for the response; the parser gets the raw annotated text.
  const ocrInfoSanitized = sanitizeExcelRecord(ocrInfo);
  for (const engine of Object.keys(ocrInfo)) ocrInfoSanitized[engine].ocr_text_raw = ocrInfo[engine].ocr_text;
  const ocrSanitized = sanitizeForStorage(ocrAll);

  let formattedJson = "";
  let parsingInfo = {
    model: "", thinking_budget_requested: "", input: 0, output: 0, thinking_tokens: 0,
    cost_in: 0, cost_out: 0, thinking_cost: 0, total_cost: 0,
  };
  let currentPrompt = promptKey;
  if (!ocrOnly) {
    const parsed = await runParse({
      ocrText: ocrAll, promptName, model: llmModel, thinkingLevel: llmLevel, gemini, signal,
    });
    formattedJson = sanitizeExcelRecord(parsed.formattedJson);
    currentPrompt = parsed.promptName;
    parsingInfo = {
      model: llmModel,
      thinking_budget_requested: llmLevel,
      input: parsed.usage.promptTokens,
      output: parsed.usage.outputTokens,
      thinking_tokens: parsed.usage.thinkingTokens,
      cost_in: 0, cost_out: 0, thinking_cost: 0, total_cost: 0,
    };
  }

  return {
    filename,
    url_source: "",
    payment_inference: "user_supplied_gemini_key",
    host: HOST_NAME,
    prompt: currentPrompt,
    ocr_info: ocrInfoSanitized,
    WFO_info: "",
    COP90_elevation_m: "",
    ocr: ocrSanitized,
    formatted_json: formattedJson,
    formatted_md: notebookMode ? ocrAll.trim() : "",
    parsing_info: parsingInfo,
    impact: {},
    collage_info: {
      position_original: {},
      position_collage: {},
      emulated: true,
      image_width: image.width,
      image_height: image.height,
      image_resized: image.resized,
      timing_ms: { prepare: tPrep - t0, ocr: tOcr - tPrep, parse: Date.now() - tOcr },
    },
    collage_image_format: "jpeg",
    success: {
      image_available: "True",
      text_collage: "False",
      text_collage_resize: "none",
      ocr: "True",
      llm: ocrOnly ? "False" : "True",
    },
    total_request_cost_usd: 0,
  };
}

module.exports = { processImage, createLimiter, HOST_NAME, DEFAULT_MODEL, DEFAULT_PROMPT };
