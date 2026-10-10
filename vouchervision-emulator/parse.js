/*
 * Parsing step — turns OCR text into the prompt's JSON template, emulating
 * VoucherVision PromptCatalog.prompt_SLTP + GoogleGeminiHandler.call_llm_api_GoogleGemini.
 *
 * Request shape for Gemini 3 (LLM_GoogleGemini.py call_google_gemini, gemini-3 branch):
 *   contents = "Answer the user query.\nReturn a JSON object.\n<prompt_SLTP>\n"
 *   thinking_level, response_modalities=["TEXT"], MEDIA_RESOLUTION_HIGH — no temperature/top_p.
 * The emulator additionally requests JSON mode (responseMimeType) and replaces LangChain's
 * RetryWithErrorOutputParser with plain re-calls when the reply is not a JSON object.
 */

const { generateContent } = require("../gemini-client");
const { getParseTemplate, getParsePrompt } = require("./prompt-catalog");
const { parseLlmJson, validateAndAlignJsonKeysWithTemplate } = require("./json-validator");

// Python json.dumps(obj, sort_keys=False) with default separators (", ", ": ") and ensure_ascii.
function pyJsonDumps(obj) {
  const esc = (s) => JSON.stringify(s).replace(/[\u007f-￿]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  if (Array.isArray(obj)) return "[" + obj.map(pyJsonDumps).join(", ") + "]";
  if (obj && typeof obj === "object") {
    return "{" + Object.entries(obj).map(([k, v]) => `${esc(k)}: ${pyJsonDumps(v)}`).join(", ") + "}";
  }
  if (typeof obj === "string") return esc(obj);
  return String(obj);
}

// PromptCatalog.remove_colons_and_double_apostrophes
function removeColonsAndDoubleApostrophes(text) {
  return String(text).replace(/:/g, "").replace(/"/g, "");
}

// PromptCatalog.create_structure: {key: '' for key in rules}
function templateStructure(rules) {
  const out = {};
  for (const key of Object.keys(rules)) out[key] = "";
  return out;
}

// Returns { prompt, dictionaryStructure, promptName }. `prompt` is the exact text sent.
function buildParsePrompt(promptNameOrPath, ocrText) {
  const { name, config } = getParsePrompt(promptNameOrPath);
  const tpl = getParseTemplate();
  const dictionaryStructure = templateStructure(config.rules);

  const subs = {
    instructions:                String(config.instructions),
    json_formatting_instructions: String(config.json_formatting_instructions),
    rules:                       pyJsonDumps(config.rules),
    OCR:                         removeColonsAndDoubleApostrophes(ocrText),
    dictionary_structure:        pyJsonDumps(dictionaryStructure),
  };
  const body = tpl.prompt_lines.join("\n").replace(/\{(\w+)\}/g, (m, k) => (k in subs ? subs[k] : m));
  const prompt = tpl.wrapper_prefix_lines.join("\n") + "\n" + body + tpl.wrapper_suffix;
  return { prompt, dictionaryStructure, promptName: name };
}

function parseGenerationConfig(thinkingLevel) {
  return {
    responseMimeType: "application/json",
    responseModalities: ["TEXT"],
    mediaResolution: "MEDIA_RESOLUTION_HIGH",
    thinkingConfig: { thinkingLevel },
  };
}

// Returns { formattedJson, usage, prompt, promptName, attempts }.
async function runParse({ ocrText, promptName, model, thinkingLevel, gemini, signal, maxJsonAttempts = 3 }) {
  const { prompt, dictionaryStructure, promptName: resolvedName } = buildParsePrompt(promptName, ocrText);
  const usage = { promptTokens: 0, outputTokens: 0, thinkingTokens: 0, totalTokens: 0 };
  const { limit = (fn) => fn(), ...geminiOpts } = gemini;

  let lastText = "";
  for (let attempt = 1; attempt <= maxJsonAttempts; attempt++) {
    const res = await limit(() => generateContent({
      ...geminiOpts,
      model,
      parts: [{ text: prompt }],
      generationConfig: parseGenerationConfig(thinkingLevel),
      signal,
    }));
    for (const k of Object.keys(usage)) usage[k] += res.usage[k] || 0;
    lastText = res.text;

    const parsed = parseLlmJson(res.text);
    const aligned = parsed ? validateAndAlignJsonKeysWithTemplate(parsed, dictionaryStructure) : null;
    if (aligned) return { formattedJson: aligned, usage, prompt, promptName: resolvedName, attempts: attempt };
  }
  throw new Error(`Parsing model ${model} did not return a JSON object after ${maxJsonAttempts} attempts. Last reply: ${lastText.slice(0, 200)}`);
}

module.exports = { runParse, buildParsePrompt, parseGenerationConfig, pyJsonDumps, removeColonsAndDoubleApostrophes };
