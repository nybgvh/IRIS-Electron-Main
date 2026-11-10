// IRIS pipelines in pure JavaScript (replaces voucher_pipeline.py, pipeline.py, ocr_pipeline.py).
// Every function takes an `emit(msg)` callback producing the same events the renderer already handles,
// and an AbortSignal for cancellation.
const fs = require("fs");
const path = require("path");

const MODEL = "gemini-3.1-pro-preview";
const IMG_EXTS = new Set([".jpg",".jpeg",".png",".webp",".tif",".tiff",".jfif",".bmp",".heic",".heif",".jp2"]);
const MAX_PIXELS = 4096 * 4096;
const SECTION_KEYS = ["taxonomy","geographic_range","habitat","ecology","use_and_trade","threats"];
const NO_INFO = "No information available from specimen records.";

const VOUCHER_PROMPT = `You are a specialist in digitising natural history museum herbarium specimen labels.

Your task is to extract all text from this herbarium specimen image and return it as a structured JSON object.

INSTRUCTIONS:
1. Extract all visible text from labels, barcodes, and annotations on the specimen sheet.
2. Map the extracted text to the appropriate JSON fields below.
3. Handwritten text appears between guillemet quotes «like this» in OCR — include the content only, not the markers.
4. Stricken/redacted text appears between section signs §like this§ — include in identificationHistory only.
5. Leave fields as empty strings if the information is not present.
6. Only return a valid JSON object — no explanation, no markdown fences.
7. After extracting fields, if decimalLatitude and decimalLongitude are empty, infer coordinates from the locality information using your geographic knowledge. Only infer if specific enough (city, landmark, park, intersection). Use 'verbatim' in inferredGPSConfidence if coordinates appear on the label, 'high' for specific locations, 'medium' for counties, 'low' for states/provinces, 'na' if too vague.

Return this exact JSON structure:
{
  "catalogNumber": "", "scientificName": "", "genus": "", "specificEpithet": "",
  "scientificNameAuthorship": "", "collectedBy": "", "collectorNumber": "", "identifiedBy": "",
  "identifiedDate": "", "identifiedConfidence": "", "identifiedRemarks": "", "identificationHistory": "",
  "verbatimCollectionDate": "", "collectionDate": "", "collectionDateEnd": "", "habitat": "",
  "specimenDescription": "", "cultivated": "", "continent": "", "country": "", "stateProvince": "",
  "county": "", "locality": "", "verbatimCoordinates": "", "decimalLatitude": "", "decimalLongitude": "",
  "inferredGPSConfidence": "", "minimumElevationInMeters": "", "maximumElevationInMeters": "",
  "elevationUnits": "", "multipleBarcodes": "", "additionalText": ""
}`;

const SUMMARY_PROMPT = `
You are extracting Red List assessment information from herbarium specimen OCR records.

LANGUAGE REQUIREMENT — CRITICAL:
Write the entire output in {language}. All section text, narratives, labels, and any stated
unavailability must be in {language}. Do not mix languages.

Use only information present in the records. Do not invent information.
The ONE exception is the habitat section, where inference is required (see HABITAT INFERENCE below).

CRITICAL CITATION RULE:
Every specimen filename must be cited individually, each preceded by its own "source_image:" prefix.
This prefix MUST always be written as exactly "source_image:" regardless of the output language.
The filename cited must be the exact value of the "source_image" field from the record — do NOT add any file extension such as .json, .jpg, .png etc.
NEVER translate, abbreviate, or change this prefix. It must appear in English in ALL outputs.
CORRECT:  source_image: abc123, source_image: def456
WRONG:    source_image: abc123, def456
WRONG:    source: abc123
WRONG:    fuente: abc123
WRONG:    fonte: abc123
WRONG:    quelle: abc123
Only "source_image:" is acceptable — never anything else.

FORMATTING RULES (applied within each section value):
1. Sub-criteria use a bullet line with a bold label, formatted exactly as:
*   **Label**
Narrative text follows on the next line(s) as plain text.
2. Bold (**text**) ONLY for sub-criterion labels.
3. Italic (*text*) ONLY for scientific names.
4. No markdown headers (##), horizontal rules (---), or extra symbols.

CORRECT example for one section value:
"*   **Accepted scientific name**\\nThe accepted name is *Carissa spinarum* L. (source_image: abc123, source_image: def456).\\n\\n*   **Taxonomic notes**\\nNo information available from specimen records."

OUTPUT FORMAT — CRITICAL:
You MUST respond with ONLY a valid JSON object. No prose before or after. No markdown fences.
The JSON must have exactly these six keys:
  "taxonomy", "geographic_range", "habitat", "ecology", "use_and_trade", "threats"

Each value is a plain string containing the formatted assessment text for that section.

If information is not available for a section, use:
"No information available from specimen records."

SECTION REQUIREMENTS:

taxonomy:
* Accepted scientific name
* Identification history and taxonomic notes
* Any uncertainty in identification

geographic_range:
* Countries, states, provinces, localities
* Distribution patterns, elevation range, geographic concentrations
* GPS coordinates: for each specimen with decimalLatitude/decimalLongitude, report coordinates
  and note whether inferredGPSConfidence is "verbatim" or inferred

habitat:
* Habitat descriptions, substrate, vegetation, moisture conditions
* Habitat patterns and unusual habitats
* IUCN Habitat Classification Scheme categories

HABITAT INFERENCE (habitat section only):
For the sub-criterion "IUCN Habitat Classification Scheme categories" you MUST propose the most likely
IUCN Habitat Classification Scheme categories (e.g. "1.6 Forest - Subtropical/Tropical Moist Lowland"),
even when no habitat is stated on any label. Base the prediction on the evidence in the records:
locality, country, coordinates, elevation, growth form, associated vegetation and any habitat notes.
Rules for this inference:
1. Begin each predicted category with the word "Inferred:" so it is clearly separate from facts stated on labels.
2. After each prediction give the evidence it rests on, with source_image citations where the evidence comes from specific records.
3. State your confidence (high, medium or low) for each predicted category.
4. Never present an inferred category as if it were written on a label. Facts stated on labels go in the other
   habitat sub-criteria, without the "Inferred:" prefix.
5. Only if the records contain nothing at all that could indicate habitat (no locality, coordinates or elevation),
   write "No information available from specimen records." for this sub-criterion.
This inference applies ONLY to the IUCN habitat categories. All other sections must still contain only information present in the records.

ecology:
* Growth form, life history, phenology (flowering/fruiting/sterile)
* Associated vegetation, ecological observations
* Elevational and substrate preferences

use_and_trade:
* Medicinal, food, ornamental, timber, fiber, cultural use
* Cultivation, harvesting, trade
* Only report uses explicitly mentioned

threats:
* Habitat destruction, agriculture, grazing, logging, urbanization, fire, invasive species
* Protected areas, reserves, ex situ collections
* IUCN Threat scheme classification

Records:
{records}
`;

// ── helpers ───────────────────────────────────────────────────────────────────
function friendlyGeminiError(err, subject) {
  const s = String((err && err.message) || err);
  const who = subject ? ` for ${subject}` : "";
  const raw = ` [Google said: ${s.replace(/\s+/g, " ").slice(0, 200)}]`;
  const code = (err && (err.status || err.code)) || (s.match(/"code"\s*:\s*(\d{3})/) || [])[1] || (s.match(/\b(?:got status|status)[: ]+(\d{3})/i) || [])[1];
  const is = (n, re) => String(code) === String(n) || re.test(s);
  if (is(429, /RESOURCE_EXHAUSTED/)) return `Quota exceeded${who} — ${MODEL} requires billing enabled on your Google account. Go to aistudio.google.com to enable billing.` + raw;
  if (is(401, /UNAUTHENTICATED|API key not valid|API_KEY_INVALID/i) || is(403, /PERMISSION_DENIED/)) return `API key problem${who} — check your Gemini API key and its access in Settings.` + raw;
  if (is(404, /NOT_FOUND|is not found for API version|models\/[\w.-]+ is not found/i)) return `Model not available${who} — Google says ${MODEL} was not found for this key.` + raw;
  if (is(503, /UNAVAILABLE|overloaded/i)) return `Gemini is temporarily overloaded${who} — try again in a moment.` + raw;
  if (is(504, /DEADLINE_EXCEEDED|timed? ?out/i)) return `Timeout${who} — the image or request may be too large.` + raw;
  if (is(500, /INTERNAL/)) return `Gemini server error${who} — please try again in a moment.` + raw;
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|fetch failed|network/i.test(s)) return `Network error${who} — check your internet connection.` + raw;
  return `Failed${who}: ${s.slice(0, 200)}`;
}

function cleanJsonText(t) {
  t = String(t || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  return a !== -1 && b !== -1 ? t.slice(a, b + 1) : t;
}

// Convert any supported image to a JPEG buffer, downscaled to ~16 MP. Throws if unreadable.
async function toJpegBuffer(file) {
  const sharp = require("sharp");
  sharp.cache(false); // don't keep image files open (on Windows an open file blocks deleting the folder)
  const ext = path.extname(file).toLowerCase();
  if (ext === ".heic" || ext === ".heif") {
    throw new Error("HEIC/HEIF is not supported — convert to JPG or PNG first.");
  }
  const img = sharp(fs.readFileSync(file), { limitInputPixels: false }).rotate(); // read into memory: no open file handle
  let meta;
  try { meta = await img.metadata(); }
  catch (_) { throw new Error("could not read this file — it is unsupported or corrupt."); }
  let pipe = img;
  if (meta.width && meta.height && meta.width * meta.height > MAX_PIXELS) {
    const scale = Math.sqrt(MAX_PIXELS / (meta.width * meta.height));
    pipe = pipe.resize(Math.floor(meta.width * scale), Math.floor(meta.height * scale));
  }
  return pipe.jpeg({ quality: 92 }).toBuffer();
}

function writeRecord(speciesDir, stem, rec) {
  const dir = path.join(speciesDir, "vv_run", "Transcription", "Individual");
  fs.mkdirSync(dir, { recursive: true });
  const text = JSON.stringify(rec, null, 2);
  fs.writeFileSync(path.join(dir, `${stem}.json`), text, "utf-8");
  fs.writeFileSync(path.join(speciesDir, `${stem}.json`), text, "utf-8");
}

function listImages(speciesDir) {
  const pics = path.join(speciesDir, "pics");
  if (!fs.existsSync(pics)) return [];
  return fs.readdirSync(pics).filter(f => IMG_EXTS.has(path.extname(f).toLowerCase())).sort()
    .map(f => path.join(pics, f));
}

// ── Transcription: Gemini (herbarium labels) or Tesseract (textbooks/documents) ─
async function runTranscription({ speciesDir, apiKey, mode, ocrLang, emit, signal }) {
  const images = listImages(speciesDir);
  if (!images.length) { emit({ event: "fatal", message: `No images found in ${path.join(speciesDir, "pics")}` }); return; }

  const useOcr = mode === "ocr";
  let ai = null, worker = null;
  try {
    if (useOcr) {
      const { createWorker } = require("tesseract.js");
      emit({ event: "progress", status: "start", message: "Starting Tesseract OCR…" });
      const cacheDir = path.join(require("electron").app.getPath("userData"), "tessdata");
      fs.mkdirSync(cacheDir, { recursive: true });
      const opts = { cachePath: cacheDir, errorHandler: (e) => emit({ event: "progress", status: "warn", message: `Tesseract: ${e && e.message || e}` }) };
      // English data ships with the app (works offline); other languages download on first use.
      if (!ocrLang || ocrLang === "eng") {
        try { opts.langPath = path.join(path.dirname(require.resolve("@tesseract.js-data/eng/package.json")), "4.0.0_best_int"); } catch (_) {}
      }
      worker = await createWorker(ocrLang || "eng", 1, opts);
    } else {
      const { GoogleGenAI } = require("@google/genai");
      ai = new GoogleGenAI({ apiKey, apiVersion: "v1beta" });
    }
  } catch (e) {
    emit({ event: "fatal", message: `Could not start ${useOcr ? "Tesseract" : "Gemini"}: ${e.message}` });
    return;
  }

  emit({ event: "progress", status: "start", message: `Processing ${images.length} image(s)…` });
  emit({ event: "progress", status: "processing", message: useOcr
    ? `Reading ${images.length} image(s) with Tesseract…`
    : `Transcribing ${images.length} image(s) with Gemini — this may take a few minutes…` });

  let succeeded = 0, failed = 0;
  try {
    for (let i = 0; i < images.length; i++) {
      if (signal.aborted) break;
      const file = images[i], name = path.basename(file), stem = path.parse(file).name;
      const tag = `[${i + 1}/${images.length}] ${name}`;
      const out = path.join(speciesDir, "vv_run", "Transcription", "Individual", `${stem}.json`);
      if (fs.existsSync(out)) {
        emit({ event: "progress", status: "processing", message: `${tag} — already transcribed, skipping.` });
        succeeded++; continue;
      }
      emit({ event: "progress", status: "processing", message: tag });
      try {
        const jpg = await toJpegBuffer(file);
        if (useOcr) {
          const { data } = await worker.recognize(jpg);
          const text = (data.text || "").trim();
          if (!text) { emit({ event: "progress", status: "warn", message: `${tag} — no text recognized, skipping.` }); failed++; continue; }
          writeRecord(speciesDir, stem, { filename: name, source_image: stem, ocr: text, formatted_json: { additionalText: text } });
        } else {
          const resp = await ai.models.generateContent({
            model: MODEL,
            contents: [{ role: "user", parts: [{ text: VOUCHER_PROMPT }, { inlineData: { mimeType: "image/jpeg", data: jpg.toString("base64") } }] }],
            config: { httpOptions: { timeout: 300000 }, abortSignal: signal },
          });
          const raw = resp.text;
          if (!raw) {
            const c = resp.candidates && resp.candidates[0];
            const why = (c && c.finishReason) || (resp.promptFeedback && resp.promptFeedback.blockReason) || "unknown";
            emit({ event: "progress", status: "warn", message: `${tag} — Gemini returned no text (reason: ${why}), skipping.` });
            failed++; continue;
          }
          const cleaned = cleanJsonText(raw);
          writeRecord(speciesDir, stem, { filename: name, source_image: stem, ocr: cleaned, formatted_json: JSON.parse(cleaned) });
        }
        emit({ event: "progress", status: "processing", message: `${tag} — done ✓` });
        succeeded++;
      } catch (e) {
        if (signal.aborted) break;
        emit({ event: "progress", status: "warn", message: `${tag} — ${useOcr || /could not read|HEIC/.test(e.message) ? e.message : friendlyGeminiError(e)}` });
        failed++;
      }
    }
  } finally {
    if (worker) { try { await worker.terminate(); } catch (_) {} }
  }

  if (signal.aborted) return;
  if (succeeded === 0) { emit({ event: "done", succeeded: 0, failed, cleanup: true }); return; }
  emit({ event: "progress", status: "complete", message: `Done — ${succeeded}/${succeeded + failed} transcribed${failed ? `, ${failed} failed` : ""}` });
  emit({ event: "done", succeeded, failed });
}

// ── Red List summary ──────────────────────────────────────────────────────────
function readRecords(dir) {
  const records = [], skipped = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith(".json") && f !== "red_list_summary_rd.json").sort()) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
      const fmt = data.formatted_json || data;
      records.push({
        source_image: path.parse(f).name,
        scientificName: fmt.scientificName, country: fmt.country, stateProvince: fmt.stateProvince,
        locality: fmt.locality, decimalLatitude: fmt.decimalLatitude, decimalLongitude: fmt.decimalLongitude,
        inferredGPSConfidence: fmt.inferredGPSConfidence, habitat: fmt.habitat,
        specimenDescription: fmt.specimenDescription, minimumElevationInMeters: fmt.minimumElevationInMeters,
        maximumElevationInMeters: fmt.maximumElevationInMeters, collectionDate: fmt.collectionDate,
        additionalText: fmt.additionalText, ocr_text: data.ocr,
      });
    } catch (e) { skipped.push(`${f}: ${e.message}`); }
  }
  return { records, skipped };
}

async function runSummary({ outputRoot, species, apiKey, language, emit, signal }) {
  const dir = path.join(outputRoot, species);
  if (!fs.existsSync(dir)) { emit({ event: "fatal", message: `Species folder not found: ${dir}` }); return; }
  emit({ event: "start", total: 1 });
  const { records, skipped } = readRecords(dir);
  skipped.forEach(s => emit({ event: "progress", species, status: "warn", message: `Could not read ${s}` }));
  if (!records.length) {
    emit({ event: "progress", species, status: "skip", message: "No JSON specimen files found" });
    emit({ event: "finish", total: 1, succeeded: 0, failed: 1 }); return;
  }
  emit({ event: "progress", species, status: "start", message: `Reading ${records.length} specimen records…` });
  emit({ event: "progress", species, status: "generating", message: `Sending ${records.length} records to Gemini — this may take a few minutes…` });

  const lang = language || "English";
  const prompt = SUMMARY_PROMPT.split("{language}").join(lang).replace("{records}", JSON.stringify(records, null, 2));
  let text;
  try {
    const { GoogleGenAI } = require("@google/genai");
    const resp = await new GoogleGenAI({ apiKey, apiVersion: "v1beta" }).models.generateContent({
      model: MODEL, contents: prompt, config: { httpOptions: { timeout: 300000 }, abortSignal: signal },
    });
    text = resp.text;
    if (!text) throw new Error("Gemini returned an empty response.");
  } catch (e) {
    if (signal.aborted) return;
    emit({ event: "error", species, message: friendlyGeminiError(e) });
    emit({ event: "finish", total: 1, succeeded: 0, failed: 1 }); return;
  }

  let sections;
  try {
    sections = JSON.parse(cleanJsonText(text));
    for (const k of SECTION_KEYS) if (!(k in sections)) sections[k] = NO_INFO;
  } catch (e) {
    try { fs.writeFileSync(path.join(dir, "_debug_response.txt"), text, "utf-8"); } catch (_) {}
    emit({ event: "error", species, message: `JSON parse failed: ${e.message}. See _debug_response.txt in the species folder.` });
    emit({ event: "finish", total: 1, succeeded: 0, failed: 1 }); return;
  }
  const output = { generated_at: new Date().toISOString(), model: MODEL, language: lang, species, sections };
  try { fs.writeFileSync(path.join(dir, "red_list_summary_rd.json"), JSON.stringify(output, null, 2), "utf-8"); }
  catch (e) { emit({ event: "error", species, message: `Could not write output: ${e.message}` }); emit({ event: "finish", total: 1, succeeded: 0, failed: 1 }); return; }
  // Plain-text copy for reading outside the app (non-fatal)
  try {
    const TITLES = { taxonomy: "1. Taxonomy", geographic_range: "2. Geographic Range", habitat: "3. Habitat",
      ecology: "4. Ecology", use_and_trade: "5. Use and Trade", threats: "6. Threats and Conservation Actions" };
    let txt = `IRIS — Integrated Red List Inference from Specimens\n${"=".repeat(60)}\n` +
      `Species:   ${species.replace(/_/g, " ")}\nLanguage:  ${lang}\nModel:     ${MODEL}\nGenerated: ${output.generated_at}\n${"=".repeat(60)}\n\n`;
    for (const [k, title] of Object.entries(TITLES)) {
      let t = String(sections[k] || NO_INFO).replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*([^*]+?)\*/g, "$1").replace(/^\*\s+/gm, "  • ");
      txt += `${title}\n${"-".repeat(title.length)}\n${t}\n\n`;
    }
    fs.writeFileSync(path.join(dir, "red_list_summary_rd.txt"), txt, "utf-8");
  } catch (_) {}
  emit({ event: "done", species });
  emit({ event: "finish", total: 1, succeeded: 1, failed: 0 });
}

module.exports = { runTranscription, runSummary, friendlyGeminiError, cleanJsonText, readRecords };
