/*
 * OCR step — one Gemini call per engine, emulating VoucherVisionGO
 * VoucherVisionProcessor.perform_ocr + VoucherVision OCRGeminiProVision.ocr_gemini.
 *
 * Request shape for Gemini 3 (OCR_Gemini.py ocr_gemini, gemini-3 branch):
 *   contents = [prompt_text, inline JPEG]
 *   top_p=0.95, max_output_tokens=32768 (VVGO's value), thinking_level, MEDIA_RESOLUTION_HIGH,
 *   all safety categories BLOCK_NONE, NO temperature.
 */

const { generateContent } = require("../gemini-client");
const { getOcrPrompt }    = require("./prompt-catalog");

const SAFETY_BLOCK_NONE = [
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
].map(category => ({ category, threshold: "BLOCK_NONE" }));

const OCR_TOP_P             = 0.95;
const OCR_MAX_OUTPUT_TOKENS = 32768;

function ocrGenerationConfig(thinkingLevel) {
  return {
    topP: OCR_TOP_P,
    maxOutputTokens: OCR_MAX_OUTPUT_TOKENS,
    mediaResolution: "MEDIA_RESOLUTION_HIGH",
    thinkingConfig: { thinkingLevel },
  };
}

// Runs every engine in `engines` over the prepared image. Returns
// { ocrInfo, ocrAll, promptKey } where ocrInfo mirrors VVGO's ocr_packet
// (per-engine dict) and ocrAll is the engines' text joined as `f"{response} "`.
async function runOcr({ image, engines, promptOption, thinkingLevel, gemini, signal }) {
  const { key: promptKey, text: promptText } = getOcrPrompt(promptOption);
  const parts = [
    { text: promptText },
    { inlineData: { mimeType: image.mimeType, data: image.data.toString("base64") } },
  ];

  const { limit = (fn) => fn(), ...geminiOpts } = gemini;
  const ocrInfo = {};
  let ocrAll = "";
  for (const engine of engines) {
    const { text, usage } = await limit(() => generateContent({
      ...geminiOpts,
      model: engine,
      parts,
      generationConfig: ocrGenerationConfig(thinkingLevel),
      safetySettings: SAFETY_BLOCK_NONE,
      signal,
    }));
    ocrInfo[engine] = {
      ocr_text: text,
      cost_in: 0, cost_out: 0, total_cost: 0, rates_in: 0, rates_out: 0,
      tokens_in: usage.promptTokens,
      tokens_out: usage.outputTokens,
      thinking_tokens: usage.thinkingTokens,
      thinking_cost: 0,
      thinking_budget_requested: thinkingLevel,
    };
    ocrAll += `${text} `;
  }
  return { ocrInfo, ocrAll, promptKey };
}

module.exports = { runOcr, ocrGenerationConfig, SAFETY_BLOCK_NONE };
