/*
 * Loads the prompt JSON files under prompts/.
 *   prompts/ocr/catalog.json        — OCRPromptCatalog.prompts (verbatim)
 *   prompts/parse/template.json     — prompt_SLTP skeleton + LangChain wrapper
 *   prompts/parse/<name>.json       — VoucherVision custom_prompts/<name>.yaml as JSON
 */

const fs   = require("fs");
const path = require("path");

const PROMPTS_DIR = path.join(__dirname, "prompts");

function readJson(p) { return JSON.parse(fs.readFileSync(p, "utf-8")); }

let ocrCatalog = null;
function getOcrCatalog() {
  if (!ocrCatalog) ocrCatalog = readJson(path.join(PROMPTS_DIR, "ocr", "catalog.json"));
  return ocrCatalog;
}

// Mirrors OCRGeminiProVision.ocr_gemini's key selection: None / unknown ->
// verbatim_with_annotations; "verbatim_notebook" -> verbatim_notebook.
function resolveOcrPromptKey(option) {
  const cat = getOcrCatalog();
  if (option && option in cat.prompts && (option === cat._default || option === cat._notebook)) return option;
  return cat._default;
}

function getOcrPrompt(option) {
  const key = resolveOcrPromptKey(option);
  return { key, text: getOcrCatalog().prompts[key] };
}

let parseTemplate = null;
function getParseTemplate() {
  if (!parseTemplate) parseTemplate = readJson(path.join(PROMPTS_DIR, "parse", "template.json"));
  return parseTemplate;
}

// Accepts "SLTPvM_full.yaml", "SLTPvM_full", "SLTPvM_full.json" or an absolute
// path to a prompt JSON. Returns { name, config }.
function getParsePrompt(nameOrPath) {
  const raw = String(nameOrPath || "SLTPvM_full.yaml").trim();
  let file;
  if (path.isAbsolute(raw) && raw.toLowerCase().endsWith(".json")) {
    file = raw;
  } else {
    const stem = path.basename(raw).replace(/\.(ya?ml|json)$/i, "");
    file = path.join(PROMPTS_DIR, "parse", `${stem}.json`);
  }
  if (!fs.existsSync(file)) {
    throw new Error(`Prompt "${raw}" not found in the emulator (expected ${file}). Available: ${listParsePrompts().join(", ")}`);
  }
  const config = readJson(file);
  for (const k of ["instructions", "json_formatting_instructions", "rules"]) {
    if (!(k in config)) throw new Error(`Prompt ${file} is missing the "${k}" section.`);
  }
  return { name: path.basename(raw), config };
}

function listParsePrompts() {
  return fs.readdirSync(path.join(PROMPTS_DIR, "parse"))
    .filter(f => f.endsWith(".json") && f !== "template.json")
    .map(f => f.replace(/\.json$/, ".yaml"));
}

module.exports = { getOcrCatalog, getOcrPrompt, resolveOcrPromptKey, getParseTemplate, getParsePrompt, listParsePrompts, PROMPTS_DIR };
