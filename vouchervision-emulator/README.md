# vouchervision-emulator

Produces a VoucherVisionGO `/process`-shaped response locally, with two direct
Gemini REST calls (OCR, then parsing) through IRIS's own `gemini-client.js` and
the Gemini API key from Settings. No Python, no LangChain, no SDK, no new
dependencies. Selected with `vouchervision.backend: "emulator"` in settings.json
(the default; not shown in the Settings UI); `"remote"` keeps using
`vouchervision-client.js`.

```
index.js            processImage({bytes, filename, mimeType}, cfg, signal) → response
ocr.js              one Gemini call per OCR engine  (OCRGeminiProVision.ocr_gemini, gemini-3 branch)
parse.js            prompt_SLTP port + parsing call + JSON validation
prompt-catalog.js   loads prompts/*.json; "SLTPvM_full.yaml" → prompts/parse/SLTPvM_full.json
json-validator.js   port of utils_LLM_JSON_validation.py
sanitize.js         port of OCR_sanitize.py (sanitize_for_storage / sanitize_excel_record)
image.js            ≤5.2 MP resize + JPEG q95 via Electron nativeImage
smoke.js            headless check: npm run smoke:vv -- <image> [out.json] [--model M] [--prompt P]
prompts/ocr/catalog.json      OCRPromptCatalog.prompts, verbatim (default: verbatim_with_annotations)
prompts/parse/template.json   prompt_SLTP skeleton + LangChain wrapper lines, verbatim
prompts/parse/SLTPvM_full.json  custom_prompts/SLTPvM_full.yaml via yaml.safe_load
```

## Provenance

Source repos (reference only, never modified): `Dropbox/VoucherVisionGO` (API,
`app.py`) and its `vouchervision_main` submodule (= `Dropbox/VoucherVision`).

| Emulator | VoucherVision source |
|---|---|
| OCR prompt text | `vouchervision/OCR_Prompt_Catalog.py` — `verbatim_with_annotations` is what `/process` uses by default; `verbatim_notebook` for `notebook_mode` |
| OCR request config | `vouchervision/OCR_Gemini.py` `ocr_gemini` gemini-3 branch: `top_p=0.95`, `max_output_tokens=32768` (VVGO `perform_ocr`), `thinking_level`, `MEDIA_RESOLUTION_HIGH`, safety `BLOCK_NONE`, no temperature |
| Multi-engine join | `app.py` `perform_ocr`: `ocr_all += f"{response} "` |
| Parse prompt | `vouchervision/prompt_catalog.py` `prompt_SLTP` + LangChain `PromptTemplate("Answer the user query.\n{format_instructions}\n{query}\n")` with `JsonOutputParser().get_format_instructions() == "Return a JSON object."` |
| Parse request config | `vouchervision/LLM_GoogleGemini.py` `call_google_gemini` gemini-3 branch: `thinking_level`, `response_modalities=["TEXT"]`, `MEDIA_RESOLUTION_HIGH` |
| JSON cleanup | `vouchervision/utils_LLM_JSON_validation.py` `validate_and_align_JSON_keys_with_template` |
| Response sanitizing | `vouchervision/OCR_sanitize.py`; applied to `ocr`, `ocr_info`, `formatted_json` as in `app.py` `process_image_request` |
| Response envelope | `app.py` `process_image_request` (key order preserved) |

To add another prompt: convert the YAML with `python3 -c 'import yaml,json,sys;
json.dump(yaml.safe_load(open(sys.argv[1])), open(sys.argv[2],"w"), indent=2,
ensure_ascii=False)' X.yaml prompts/parse/X.json` and set the `prompt` setting
to `X.yaml`.

## Deliberate differences from VoucherVisionGO

- **Whole image, no label collage.** VVGO runs a YOLO detector and OCRs a collage
  of the label crops; the emulator OCRs the full image resized to ≤5.2 MP (the
  same cap VVGO applies to uploads). `collage_info` has empty position maps and
  `emulated: true`; `success.text_collage` is `"False"`.
- **Gemini JSON mode.** The parsing call sets `responseMimeType: "application/json"`
  (VoucherVision relies on LangChain's parser instead). If the reply is still not
  a JSON object, the same prompt is re-sent up to 3 times total, replacing
  LangChain's `RetryWithErrorOutputParser`.
- **Template dict rendering.** `prompt_SLTP` renders the empty template with
  Python `repr` (`{'catalogNumber': '', …}`); the emulator renders JSON
  (`{"catalogNumber": "", …}`). Same keys, same order; everything else in the
  prompt is byte-identical (verified by diffing against the Python output).
- **Not computed:** WFO backbone lookup (`WFO_info: ""`), COP90 elevation
  (`COP90_elevation_m: ""`), costs and `impact` (all 0 / `{}`),
  `total_request_cost_usd: 0`. Token counts come from Gemini `usageMetadata`.
- **Notebook mode** returns the raw markdown in `formatted_md` and a
  `sanitize_for_storage` copy in `ocr` (VVGO additionally flattens markdown to
  plain text).
- **Retries:** 429 is retried with backoff (VoucherVision treats it as fatal);
  400/401/403/404 are not.
- **Scope:** Gemini 3.x only (tested with `gemini-3.1-flash-lite`). No Vertex AI,
  Gemini ≤2.5, Gemma, or Firestore user prompts.

Extra field: `ocr_info.<engine>.ocr_text_raw` keeps the unsanitized, annotated
OCR text (`§stricken§`, `«handwritten»`, line breaks) that the parser received.
