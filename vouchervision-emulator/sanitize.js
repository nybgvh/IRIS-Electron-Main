/*
 * Port of VoucherVision vouchervision/OCR_sanitize.py (the parts VoucherVisionGO's
 * /process endpoint applies to its response):
 *   - sanitizeForStorage(ocr)      -> the top-level `ocr` string
 *   - sanitizeExcelRecord(obj)     -> `ocr_info` and `formatted_json`
 * The LLM never sees sanitized text; VVGO sanitizes only the stored/returned copy.
 */

// DANGER_PREFIXES = ("=", "+", "@")  — "-" is excluded because it appears in GPS coordinates
const DANGER_PREFIXES = ["=", "+", "@"];

const XML_ILLEGAL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

// Header patterns to remove from top-of-output OCR blocks
// (e.g. "gemini-2.5-flash OCR:", "Qwen2VL OCR:", "Florence2 OCR:", etc.)
const HEADER_RE = new RegExp(
  "^\\s*(?:" +
    "gemini[-\\s]?(?:[0-9.]+)?(?:[-\\s]?(?:flash|pro))?" +
    "|qwen2vl" +
    "|qwen[-\\s]?(?:vl|vision|ocr|vlm)?" +
    "|florence[-\\s]?(?:2|ocr)?" +
    "|deepseek[-\\s]?(?:vl|ocr|vision)?" +
    "|google[-\\s]?(?:cloud|vision|ocr)?" +
    "|pali[-\\s]?(?:gemma|gemma2|gemini)?" +
    "|gpt[-\\s]?(?:4|4v|4o|4o-mini)?" +
    "|ocr\\s+version\\s+\\d+[:]?" +
  ")\\s*\\n?",
  "gim"
);

function stripHeaders(text) {
  if (typeof text !== "string") return text;
  return text.replace(HEADER_RE, "");
}

// Keep the content, but make it API/Excel-friendly: newlines -> space, drop § « »,
// remove visual wrappers <<< >>> ~~~, collapse multiple spaces.
function basicCleanup(text) {
  if (typeof text !== "string") return text;
  let s = text.replace(/\r/g, " ").replace(/\n/g, " ");
  s = s.replace(/§/g, "").replace(/«/g, "").replace(/»/g, "");
  s = s.replace(/(?:<{3,}|>{3,}|~{3,})/g, "");
  s = s.replace(/~/g, "").replace(/</g, "").replace(/>/g, "");
  s = s.replace(/\s{2,}/g, " ").trim();
  return s;
}

// Prevent Excel from interpreting the cell as a formula when later exported to .xlsx.
function excelGuard(text) {
  if (typeof text !== "string" || !text) return text;
  if (text.startsWith("'")) return text;
  const stripped = text.replace(/^\s+/, "");
  if (stripped && DANGER_PREFIXES.includes(stripped[0])) {
    const lead = text.length - stripped.length;
    return text.slice(0, lead) + "'" + stripped;
  }
  return text;
}

function sanitizeXmlIllegal(s) {
  s = s.replace(/\r/g, " ").replace(/\n/g, " ").replace(/\t/g, " ");
  return s.replace(XML_ILLEGAL, " ");
}

// One-shot sanitizer for the saved copy of the OCR text.
function sanitizeForStorage(text, { removeHeaders = true, guardExcel = true } = {}) {
  if (typeof text !== "string") return text;
  if (removeHeaders) text = stripHeaders(text);
  text = basicCleanup(text);
  if (guardExcel) text = excelGuard(text);
  return text;
}

function cleanScalarForExcel(x) {
  if (typeof x === "string") {
    x = stripHeaders(x);
    x = sanitizeXmlIllegal(x);
    x = basicCleanup(x);
    x = excelGuard(x);
  }
  return x;
}

// Deep-sanitize a JSON-like object (dict/list/str).
function sanitizeExcelRecord(obj) {
  if (Array.isArray(obj)) return obj.map(sanitizeExcelRecord);
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = sanitizeExcelRecord(v);
    return out;
  }
  return cleanScalarForExcel(obj);
}

module.exports = { stripHeaders, basicCleanup, excelGuard, sanitizeForStorage, sanitizeExcelRecord };
