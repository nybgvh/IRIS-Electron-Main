/*
 * Port of VoucherVision vouchervision/utils_LLM_JSON_validation.py:
 *   validateAndAlignJsonKeysWithTemplate(data, template)  (validate_and_align_JSON_keys_with_template)
 *   validateJSON(data)                                     (validate_JSON)
 *   extractJsonDictManual(text)                            (extract_json_dict_manual)
 * plus parseLlmJson(text), which replaces LangChain's JsonOutputParser / parse_json_markdown
 * (strip ```json fences, tolerate prose around the object).
 */

// Null-phrase lists copied verbatim from the Python source.
const LIST_OF_NULLS = ['unknown','not provided', 'missing', 'na', 'none', 'n/a', 'null', 'unspecified', 'not known','not given',
                                     'TBD', 'tbd',
                                    'not provided in the text', 'not found in the text', 'Not found in OCR text', 'not found in ocr text',
                                    'not in the text', 'not provided', 'not found',
                                    'not provided in the ocr', 'not found in the ocr',
                                    'not in the ocr',
                                    'not provided in the ocr text', 'not found in the ocr text',
                                    "not specified in the given text.",
                                    "not specified in the given text",
                                    "not specified in the text.",
                                    "not specified in the text",
                                    "not specified in text.",
                                    "not specified in text",
                                    "not specified in ocr",
                                    "not specified",
                                    "google handwritten ocr",
                                    "google printed ocr",
                                    "gpt-4o-mini ocr",
                                    "qwen2-vl-7b-instruct ocr",
                                    "qwen2-vl-72b-instruct ocr",
                                    "llama-3.2-90b-vision-instruct ocr",
                                    'not in the ocr text',
                                    'Not provided in ocr text',
                                    'not provided in ocr text',
                                    'n/a n/a','n/a, n/a','Not applicable','not applicable',
                                    'n/a, n/a, n/a','n/a n/a, n/a','n/a, n/a n/a','n/a n/a n/a',
                                    'n/a, n/a, n/a, n/a','n/a n/a n/a n/a','n/a n/a, n/a, n/a','n/a, n/a n/a, n/a','n/a, n/a, n/a n/a',
                                    'n/a n/a n/a, n/a','n/a, n/a n/a n/a',
                                    'n/a n/a, n/a n/a',];
const LIST_OF_OCR_NULLS = [
            'Pixtral-12B-2409 OCR', 'Qwen2-VL-7B-Instruct OCR', 'Qwen2-VL-72B-Instruct OCR',
            'Llama-3.2-90B-Vision-Instruct OCR', 'Qwen2.5-72B-Instruct OCR', 'Qwen2.5-Coder-32B-Instruct OCR',
            'Llama-3.2-3B-Instruct OCR', 'Meta-Llama-3.1-405B-Instruct OCR', 'Meta-Llama-3.1-405B-FP8 OCR',
            'Meta-Llama-3.1-8B-Instruct OCR', 'Meta-Llama-3.1-70B-Instruct OCR', 'Meta-Llama-3-70B-Instruct OCR',
            'Hermes-3-Llama-3.1-70B OCR', 'DeepSeek-V2.5 OCR', 'Gemini-1.5-Pro OCR', 'Gemini OCR',
            'Pixtral-12B-2409', 'Qwen2-VL-7B-Instruct', 'Qwen2-VL-72B-Instruct', 'Llama-3.2-90B-Vision-Instruct',
            'Qwen2.5-72B-Instruct', 'Qwen2.5-Coder-32B-Instruct', 'Llama-3.2-3B-Instruct',
            'Meta-Llama-3.1-405B-Instruct', 'Meta-Llama-3.1-405B-FP8', 'Meta-Llama-3.1-8B-Instruct',
            'Meta-Llama-3.1-70B-Instruct', 'Meta-Llama-3-70B-Instruct', 'Hermes-3-Llama-3.1-70B',
            'DeepSeek-V2.5', 'Gemini-1.5-Pro', 'Gemini',
            ];
const NULLS_LOWER     = new Set(LIST_OF_NULLS.map(s => s.toLowerCase()));
const OCR_NULLS_LOWER = new Set(LIST_OF_OCR_NULLS.map(s => s.toLowerCase()));

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function validateJSON(data) {
  if (isPlainObject(data)) return data;
  if (Array.isArray(data)) data = data[0];
  if (isPlainObject(data)) return data;
  try {
    let candidate = JSON.parse(data);
    if (Array.isArray(candidate)) candidate = candidate[0];
    return isPlainObject(candidate) ? candidate : null;
  } catch (_) {
    return null;
  }
}

// Returns the template keys, in template order, with cleaned string values; null if
// `data` cannot be coerced to an object.
function validateAndAlignJsonKeysWithTemplate(data, JSON_dict_structure) {
  data = validateJSON(data);
  if (data == null) return null;

  // Collapse keys that differ only by case, keeping the longest value.
  const fieldContentLength = new Map(); // key_lower -> [originalKey, length, value]
  for (const [key, value] of Object.entries(data)) {
    const keyLower = key.toLowerCase();
    let strValue;
    if (value == null) strValue = "";
    else if (Array.isArray(value)) strValue = value.map(v => String(v)).join(", ");
    else if (isPlainObject(value)) strValue = JSON.stringify(value);
    else strValue = String(value);
    const lower = strValue.toLowerCase();
    if (OCR_NULLS_LOWER.has(lower) || NULLS_LOWER.has(lower)) strValue = "";
    const len = strValue.length;
    const prev = fieldContentLength.get(keyLower);
    if (!prev || len > prev[1]) fieldContentLength.set(keyLower, [key, len, strValue]);
  }
  const cleaned = {};
  for (const [originalKey, , value] of fieldContentLength.values()) {
    cleaned[originalKey] = value ? value.replace(/\*/g, "") : "";
  }

  // Re-order to the template; missing keys become "", extra keys are dropped.
  const ordered = {};
  for (const key of Object.keys(JSON_dict_structure)) {
    const truthLower = key.toLowerCase();
    let llmValue = "";
    if (key in cleaned) llmValue = cleaned[key];
    else {
      for (const dataKey of Object.keys(cleaned)) {
        if (dataKey.toLowerCase() === truthLower) { llmValue = cleaned[dataKey]; break; }
      }
    }
    ordered[key] = llmValue;
  }
  return ordered;
}

// A manual method for pulling a JSON object out of a verbose LLM response.
function extractJsonDictManual(text) {
  text = String(text).trim().replace(/\n/g, "").replace(/\\\\/g, "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}") + 1;
  if (start < 0 || end <= start) return null;
  text = text.slice(start, end);
  if (text[1] === "\\") text = text[0] + text.slice(2);
  try { return JSON.parse(text); } catch (_) { return null; }
}

// Strip markdown code fences the way LangChain's parse_json_markdown does.
function stripFences(text) {
  const m = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  return m ? m[1] : text.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "");
}

// Best-effort: JSON.parse -> fence-stripped parse -> brace slice. Returns an object or null.
function parseLlmJson(text) {
  if (text == null) return null;
  if (isPlainObject(text)) return text;
  const raw = String(text).trim();
  for (const candidate of [raw, stripFences(raw).trim()]) {
    const v = validateJSON(candidate);
    if (v) return v;
  }
  const manual = extractJsonDictManual(stripFences(raw));
  return validateJSON(manual);
}

module.exports = {
  validateJSON,
  validateAndAlignJsonKeysWithTemplate,
  extractJsonDictManual,
  parseLlmJson,
  LIST_OF_NULLS,
  LIST_OF_OCR_NULLS,
};
