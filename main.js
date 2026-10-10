const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs   = require("fs");
const db   = require("./database");
const gbifService  = require("./gbif-service");
const gbifCapture  = require("./gbif-capture");
const vvClient     = require("./vouchervision-client");
const vvEmulator   = require("./vouchervision-emulator");
const imageNormalize = require("./image-normalize");
const geminiClient = require("./gemini-client");

let mainWindow;
let activeRun   = null; // { type, cancel, controller } while a native pipeline runs
let currentUser = null; // { id, username } while logged in

// ── VoucherVisionGO settings ──────────────────────────────────────────────────
// Prefilled with the experimental IRIS_Electron settings (see its .env.example).
// `backend` picks how specimens are processed:
//   "emulator" — vouchervision-emulator/ runs the OCR + parsing Gemini calls
//                locally with the existing `geminiApiKey` setting (default).
//   "remote"   — vouchervision-client.js posts to the VoucherVisionGO server,
//                authenticating with the `authToken` setting.
// Keys are NOT stored here. These are seeded into the user-managed
// settings.json and are editable there.
const VV_DEFAULTS = {
  backend:          "emulator",
  ocrThinkingLevel: "low",      // emulator: Gemini 3 thinking level for the OCR call
  llmThinkingLevel: "low",      // emulator: Gemini 3 thinking level for the parsing call
  geminiApiBase:    "https://generativelanguage.googleapis.com",
  geminiApiVersion: "v1beta",
  prepConcurrency:  4,          // emulator: images resized at once (CPU-bound)
  geminiConcurrency: 4,         // emulator: Gemini calls in flight at once (capped at image count)
  apiBaseUrl:       "https://vouchervision-go-738307415303.us-central1.run.app",
  endpoint:         "/process",
  prompt:           "SLTPvM_full.yaml",
  engines:          "gemini-3.1-pro-preview",
  llmModel:         "gemini-3.1-pro-preview",
  ocrOnly:          false,
  notebookMode:     false,
  skipLabelCollage: false,
  includeWfo:       true,
  includeCop90:     true,
  vertexProject:    "",
  vertexRegion:     "global",
  concurrency:      4,          // remote: how many images submit to the server at once
  submitTimeoutMs:  300000,     // 5-minute per-image timeout
  maxRetries:       2,          // retries on network / 5xx errors
};

// ── Red List summary (native Gemini) settings ─────────────────────────────────
// Seeded into settings.json; the API key reuses the existing `geminiApiKey`.
const REDLIST_DEFAULTS = {
  model:     "gemini-3.1-pro-preview",
  apiBase:   "https://generativelanguage.googleapis.com",
  timeoutMs: 300000,
};

// ── Settings (shared API key) ─────────────────────────────────────────────────
const settingsPath = path.join(app.getPath("userData"), "settings.json");
function loadSettings() {
  try { if (fs.existsSync(settingsPath)) return JSON.parse(fs.readFileSync(settingsPath, "utf-8")); } catch (_) {}
  return {};
}
function saveSettings(data) {
  try { fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2)); } catch (_) {}
}

// Seed the VoucherVisionGO + Red List constants into settings.json (merging over
// anything the user has already edited) so they live in the user-managed file.
function ensureSettingsDefaults() {
  const s = loadSettings();
  s.vouchervision = { ...VV_DEFAULTS,      ...(s.vouchervision || {}) };
  s.redlist       = { ...REDLIST_DEFAULTS, ...(s.redlist || {}) };
  saveSettings(s);
}

// Build the config the native VV client expects: seeded/edited VV settings plus
// the API key from the existing `authToken` setting.
function buildVvConfig(settings) {
  const vv = { ...VV_DEFAULTS, ...(settings.vouchervision || {}) };
  vv.apiKey       = settings.authToken || "";
  vv.geminiApiKey = settings.geminiApiKey || "";
  return vv;
}

// Map the VV settings block onto the emulator's processImage() config.
function buildEmulatorConfig(vv) {
  return {
    apiKey:           vv.geminiApiKey,
    apiBase:          vv.geminiApiBase,
    apiVersion:       vv.geminiApiVersion,
    engines:          vv.engines,
    llmModel:         vv.llmModel,
    prompt:           vv.prompt,
    ocrThinkingLevel: vv.ocrThinkingLevel,
    llmThinkingLevel: vv.llmThinkingLevel,
    ocrOnly:          vv.ocrOnly,
    notebookMode:     vv.notebookMode,
    timeoutMs:        vv.submitTimeoutMs,
    maxRetries:       vv.maxRetries,
  };
}

// Build the Red List config: seeded/edited settings plus the existing gemini key.
function buildRedlistConfig(settings) {
  const rl = { ...REDLIST_DEFAULTS, ...(settings.redlist || {}) };
  rl.apiKey = settings.geminiApiKey || "";
  return rl;
}

// ── Native Red List summary generation (ports pipeline.py) ────────────────────
const REDLIST_SECTION_KEYS = ["taxonomy", "geographic_range", "habitat", "ecology", "use_and_trade", "threats"];

// Red List prompt; {language} and {records} are substituted.
const REDLIST_PROMPT_TEMPLATE = `
You are extracting Red List assessment information from herbarium specimen OCR records.

LANGUAGE REQUIREMENT — CRITICAL:
Write the entire output in {language}. All section text, narratives, labels, and any stated
unavailability must be in {language}. Do not mix languages.

Use only information present in the records. Do not invent information.

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

function buildRedlistRecords(speciesDir) {
  const files = fs.readdirSync(speciesDir)
    .filter(f => f.endsWith(".json") && f !== "red_list_summary_rd.json" && !f.startsWith("_"));
  const records = [];
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(speciesDir, f), "utf-8"));
      const fmt = data.formatted_json || data;  // wrapped (VVGO/emulator) or flat VoucherVision JSON
      records.push({
        filename: f,
        source_image: path.basename(f, ".json"),
        scientificName:           fmt.scientificName ?? null,
        country:                  fmt.country ?? null,
        stateProvince:            fmt.stateProvince ?? null,
        locality:                 fmt.locality ?? null,
        decimalLatitude:          fmt.decimalLatitude ?? null,
        decimalLongitude:         fmt.decimalLongitude ?? null,
        inferredGPSConfidence:    fmt.inferredGPSConfidence ?? null,
        habitat:                  fmt.habitat ?? null,
        specimenDescription:      fmt.specimenDescription ?? fmt.specimenNotes ?? null,
        minimumElevationInMeters: fmt.minimumElevationInMeters ?? null,
        maximumElevationInMeters: fmt.maximumElevationInMeters ?? null,
        collectionDate:           fmt.collectionDate ?? null,
        additionalText:           fmt.additionalText ?? null,
        ocr_text:                 data.ocr ?? null,
      });
    } catch (_) { /* skip unreadable */ }
  }
  return records;
}

// Plain-text copy of a summary for reading outside the app (same layout as the
// former pipeline.py output). Non-fatal: the JSON file is the primary output.
const REDLIST_SECTION_TITLES = {
  taxonomy:         "1. Taxonomy",
  geographic_range: "2. Geographic Range",
  habitat:          "3. Habitat",
  ecology:          "4. Ecology",
  use_and_trade:    "5. Use and Trade",
  threats:          "6. Threats and Conservation Actions",
};

function writeRedlistText(speciesDir, output) {
  const rule = "=".repeat(60);
  const lines = [
    "IRIS — Integrated Red List Inference from Specimens",
    rule,
    `Species:   ${String(output.species || "").replace(/_/g, " ")}`,
    `Language:  ${output.language || "English"}`,
    `Model:     ${output.model || ""}`,
    `Generated: ${output.generated_at || ""}`,
    rule,
    "",
  ];
  for (const [key, title] of Object.entries(REDLIST_SECTION_TITLES)) {
    const text = String((output.sections || {})[key] || "No information available from specimen records.")
      .replace(/^\*\s+/gm, "  • ")            // bullets first, so "*   **Label**" isn't read as italics
      .replace(/\*\*(.+?)\*\*/g, "$1")      // bold
      .replace(/\*([^*\n]+?)\*/g, "$1");     // italic (single line)
    lines.push(title, "-".repeat(title.length), text, "");
  }
  try { fs.writeFileSync(path.join(speciesDir, "red_list_summary_rd.txt"), lines.join("\n") + "\n", "utf-8"); } catch (_) {}
}

function parseRedlistResponse(text) {
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s !== -1 && e !== -1) t = t.slice(s, e + 1);
  const parsed = JSON.parse(t);
  for (const k of REDLIST_SECTION_KEYS) {
    if (!(k in parsed)) parsed[k] = "No information available from specimen records.";
  }
  return parsed;
}

async function runRedlistNative(rootDir, speciesName, language) {
  const send = (msg) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("pipeline-event", msg); };
  const settings = loadSettings();
  const rl = buildRedlistConfig(settings);
  const user = currentUser;
  const lang = language || "English";

  if (!rl.apiKey)              { send({ event: "fatal", message: "No Gemini API key set. Add it in Settings." }); send({ event: "closed", code: 1 }); return; }
  if (!fs.existsSync(rootDir)) { send({ event: "fatal", message: `Output root not found: ${rootDir}` }); send({ event: "closed", code: 1 }); return; }

  let names;
  if (speciesName) {
    if (!fs.existsSync(path.join(rootDir, speciesName))) { send({ event: "fatal", message: `Species folder not found: ${speciesName}` }); send({ event: "closed", code: 1 }); return; }
    names = [speciesName];
  } else {
    names = fs.readdirSync(rootDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
  }

  const run = { type: "redlist", cancel: false, controller: new AbortController() };
  activeRun = run;
  send({ event: "start", total: names.length });

  let succeeded = 0, failed = 0;
  for (const sp of names) {
    if (run.cancel) break;
    const speciesDir = path.join(rootDir, sp);
    try {
      const records = buildRedlistRecords(speciesDir);
      if (!records.length) { send({ event: "progress", species: sp, status: "skip", message: "No JSON specimen files found" }); failed++; continue; }

      send({ event: "progress", species: sp, status: "start", message: `Reading ${records.length} specimen records…` });
      send({ event: "progress", species: sp, status: "generating", message: `Sending ${records.length} records to Gemini — this may take a few minutes…` });
      const prompt = REDLIST_PROMPT_TEMPLATE
        .split("{language}").join(lang)
        .replace("{records}", JSON.stringify(records, null, 2));

      const text = await geminiClient.generateJson({
        apiKey: rl.apiKey, model: rl.model, apiBase: rl.apiBase,
        prompt, timeoutMs: rl.timeoutMs, signal: run.controller.signal,
      });

      let sections;
      try {
        sections = parseRedlistResponse(text);
      } catch (e) {
        try { fs.writeFileSync(path.join(speciesDir, "_debug_response.txt"), text); } catch (_) {}
        send({ event: "error", species: sp, message: `JSON parse failed: ${e.message}. Check _debug_response.txt in species folder.` });
        failed++; continue;
      }

      const output = {
        generated_at: new Date().toISOString(),
        model: rl.model, language: lang, species: sp, sections,
      };
      fs.writeFileSync(path.join(speciesDir, "red_list_summary_rd.json"), JSON.stringify(output, null, 2));
      writeRedlistText(speciesDir, output);
      if (user) { try { db.updateSummary(user.id, sp, rootDir, output); } catch (_) {} }

      send({ event: "done", species: sp });
      succeeded++;
    } catch (err) {
      if (run.cancel) break;
      send({ event: "error", species: sp, message: geminiClient.friendlyGeminiError(err, { model: rl.model }) });
      failed++;
    }
  }

  activeRun = null;
  // On cancel the renderer has already logged "cancelled"; a "finish" event
  // would flip the panel to "Pipeline complete".
  if (!run.cancel) send({ event: "finish", total: names.length, succeeded, failed });
  send({ event: "closed", code: run.cancel ? 1 : 0 });
}

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600,
    backgroundColor: "#0f1a0f",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: process.platform === "darwin" ? { x: 14, y: 13 } : undefined, // centered in the 38px tab bar
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true, // GBIF tab embeds gbif.org in a <webview>
    },
  });
  mainWindow.loadFile("index.html");
  if (process.platform === "darwin") {
    mainWindow.webContents.on("did-finish-load", () => {
      mainWindow.webContents.executeJavaScript(
        'document.body.classList.add("platform-mac")'
      );
    });
  }
  gbifCapture.setup(mainWindow); // silent capture of attachment-style GBIF images
}

app.whenReady().then(async () => {
  await db.init(app.getPath("userData"));
  ensureSettingsDefaults();
  createWindow();
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// ── Auth IPC ──────────────────────────────────────────────────────────────────
ipcMain.handle("auth-register", (_e, username, password) => {
  if (!username || username.trim().length < 2) return { error: "Username must be at least 2 characters." };
  if (!password || password.length < 6)        return { error: "Password must be at least 6 characters." };
  const result = db.createUser(username.trim(), password);
  if (result.error) return result;
  currentUser = { id: result.id, username: result.username };
  return { ok: true, user: currentUser };
});

ipcMain.handle("auth-login", (_e, username, password) => {
  if (!username || !password) return { error: "Please enter username and password." };
  const result = db.loginUser(username.trim(), password);
  if (result.error) return result;
  currentUser = { id: result.id, username: result.username };
  return { ok: true, user: currentUser };
});

ipcMain.handle("auth-logout", () => {
  currentUser = null;
  return { ok: true };
});

ipcMain.handle("auth-current", () => currentUser);

// ── Helpers ───────────────────────────────────────────────────────────────────
const IMG_EXTS = [".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff", ".jfif", ".bmp", ".heic", ".heif", ".jp2"];

function scanPics(rootDir, speciesName) {
  const picsDir = path.join(rootDir, speciesName, "pics");
  const map = {};
  if (!fs.existsSync(picsDir)) return map;
  for (const f of fs.readdirSync(picsDir)) {
    const ext = path.extname(f).toLowerCase();
    if (!IMG_EXTS.includes(ext)) continue;
    // One entry per stem; prefer a copy Chromium can display (foo.jpg over foo.tif).
    const stem = path.basename(f, ext), p = path.join(picsDir, f);
    if (imageNormalize.preferForDisplay(map[stem], p)) map[stem] = p;
  }
  return map;
}

function scanSpecimens(rootDir, speciesName) {
  const dirPath = path.join(rootDir, speciesName);
  const specimens = [];
  for (const file of fs.readdirSync(dirPath).filter(f => f.endsWith(".json") && !f.startsWith("red_list_summary"))) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dirPath, file), "utf-8"));
      // VoucherVision's own per-image JSON is flat (fields at the top level, no
      // wrapper, no separate "ocr" key). Older files from the hosted API used a
      // {formatted_json: {...}, ocr: "..."} wrapper — support both shapes.
      const fmt = data.formatted_json || data;
      specimens.push({
        source_image:         path.basename(file, ".json"),
        filename:             file,
        scientific_name:      fmt.scientificName       || null,
        country:              fmt.country              || null,
        state_province:       fmt.stateProvince        || null,
        locality:             fmt.locality             || null,
        habitat:              fmt.habitat              || null,
        specimen_description: fmt.specimenDescription  || fmt.specimenNotes || null,
        min_elevation:        parseFloat(fmt.minimumElevationInMeters) || null,
        max_elevation:        parseFloat(fmt.maximumElevationInMeters) || null,
        collection_date:      fmt.collectionDate       || null,
        decimal_latitude:     parseFloat(fmt.decimalLatitude)  || null,
        decimal_longitude:    parseFloat(fmt.decimalLongitude) || null,
        gps_confidence:       fmt.inferredGPSConfidence || null,
        additional_text:      fmt.additionalText       || null,
        ocr_text:             data.ocr                 || null,
      });
    } catch (_) {}
  }
  return specimens;
}

function requireUser() {
  if (!currentUser) throw new Error("Not logged in.");
  return currentUser;
}

function readSummaryFile(rootDir, speciesName) {
  const jsonPath = path.join(rootDir, speciesName, "red_list_summary_rd.json");
  const txtPath  = path.join(rootDir, speciesName, "red_list_summary_rd.txt");
  if (fs.existsSync(jsonPath)) {
    try { return JSON.parse(fs.readFileSync(jsonPath, "utf-8")); } catch (_) {}
  }
  if (fs.existsSync(txtPath)) {
    return { _legacy: true, raw: fs.readFileSync(txtPath, "utf-8") };
  }
  return null;
}

function summaryExists(rootDir, speciesName) {
  return fs.existsSync(path.join(rootDir, speciesName, "red_list_summary_rd.json"))
      || fs.existsSync(path.join(rootDir, speciesName, "red_list_summary_rd.txt"));
}

// ── IPC: get-last-folder ──────────────────────────────────────────────────────
ipcMain.handle("get-last-folder", () => {
  try {
    const user = requireUser();
    return {
      lastFolder:  db.getLastFolder(user.id),
      allFolders:  db.getUserFolders(user.id),
    };
  } catch (err) { return null; }
});

// ── IPC: load-folder-from-db ──────────────────────────────────────────────────
// Returns species list from DB without touching the filesystem
ipcMain.handle("load-folder-from-db", (_e, rootDir) => {
  try {
    const user    = requireUser();
    const rows    = db.getAllSpecies(user.id, rootDir);
    const species = rows.map(r => ({
      name:          r.name,
      displayName:   r.display_name,
      hasSummary:    r.has_summary === 1,
      specimenCount: r.specimen_count,
    }));
    return { rootDir, species };
  } catch (err) { return { error: err.message }; }
});

// ── IPC: pick-folder ──────────────────────────────────────────────────────────
ipcMain.handle("pick-folder", async () => {
  const user = requireUser();
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"], title: "Select IRIS Output Folder",
  });
  if (result.canceled || !result.filePaths.length) return null;

  const rootDir = result.filePaths[0];
  const entries = fs.readdirSync(rootDir, { withFileTypes: true }).filter(e => e.isDirectory());

  const species = entries.map(e => {
    const name        = e.name;
    const dirPath     = path.join(rootDir, name);
    const summaryJsonPath = path.join(dirPath, "red_list_summary_rd.json");
    const summaryPath     = summaryJsonPath;
    const hasSummary      = fs.existsSync(summaryPath);
    const specimenCount = fs.readdirSync(dirPath).filter(f => f.endsWith(".json") && !f.startsWith("red_list_summary")).length;

    const row = db.upsertSpecies({ userId: user.id, name, displayName: name.replace(/_/g, " "), rootDir, specimenCount, hasSummary });

    if (hasSummary) {
      try {
        const raw = fs.readFileSync(summaryPath, "utf-8");
        const data = summaryPath.endsWith(".json") ? JSON.parse(raw) : raw;
        db.updateSummary(user.id, name, rootDir, data);
      } catch (_) {}
    }

    db.upsertSpecimens(row.id, scanSpecimens(rootDir, name));
    db.upsertPics(row.id, scanPics(rootDir, name));

    return { name, displayName: name.replace(/_/g, " "), hasSummary, specimenCount };
  }).sort((a, b) => a.name.localeCompare(b.name));

  return { rootDir, species };
});

// ── IPC: read-summary ─────────────────────────────────────────────────────────
ipcMain.handle("read-summary", async (_e, rootDir, speciesName) => {
  try {
    const user   = requireUser();
    const cached = db.getSummary(user.id, speciesName, rootDir);
    if (cached) return cached;

    // Try .json first, then .txt
    const jsonPath = path.join(rootDir, speciesName, "red_list_summary_rd.json");
    const txtPath  = path.join(rootDir, speciesName, "red_list_summary_rd.txt");

    if (fs.existsSync(jsonPath)) {
      const summaryJson = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
      db.updateSummary(user.id, speciesName, rootDir, summaryJson);
      return db.getSummary(user.id, speciesName, rootDir);
    }
    if (fs.existsSync(txtPath)) {
      const raw = fs.readFileSync(txtPath, "utf-8");
      db.updateSummary(user.id, speciesName, rootDir, raw);
      return { _legacy: true, raw };
    }
    return null;
  } catch (err) {
    return { error: err.message };
  }
});

// ── IPC: read-specimens ───────────────────────────────────────────────────────
ipcMain.handle("read-specimens", async (_e, rootDir, speciesName) => {
  try {
    const user = requireUser();
    const row  = db.getSpeciesByName(user.id, speciesName, rootDir);
    if (!row) return [];
    return db.getSpecimens(row.id).map(s => ({
      source_image:   s.source_image,
      lat:            s.decimal_latitude,
      lng:            s.decimal_longitude,
      confidence:     s.gps_confidence || "unknown",
      locality:       s.locality       || "",
      country:        s.country        || "",
      collectionDate: s.collection_date|| "",
    })).filter(s => s.lat != null && s.lng != null);
  } catch (err) { return []; }
});

// ── IPC: resolve-pics ─────────────────────────────────────────────────────────
ipcMain.handle("resolve-pics", async (_e, rootDir, speciesName) => {
  try {
    const user = requireUser();
    const row  = db.getSpeciesByName(user.id, speciesName, rootDir);
    if (!row) return {};
    return db.getPicsMap(row.id);
  } catch (err) { return {}; }
});

// ── IPC: refresh-species ──────────────────────────────────────────────────────
ipcMain.handle("refresh-species", async (_e, rootDir, speciesName) => {
  try {
    const user        = requireUser();
    const dirPath     = path.join(rootDir, speciesName);
    const summaryJsonPath = path.join(dirPath, "red_list_summary_rd.json");
    const summaryPath     = summaryJsonPath;
    const hasSummary      = fs.existsSync(summaryPath);
    const specimenCount = fs.readdirSync(dirPath).filter(f => f.endsWith(".json") && !f.startsWith("red_list_summary")).length;

    const row = db.upsertSpecies({
      userId: user.id, name: speciesName,
      displayName: speciesName.replace(/_/g, " "),
      rootDir, specimenCount, hasSummary,
    });

    if (hasSummary) {
      try {
        const raw = fs.readFileSync(summaryPath, "utf-8");
        const data = summaryPath.endsWith(".json") ? JSON.parse(raw) : raw;
        db.updateSummary(user.id, speciesName, rootDir, data);
      } catch (_) {}
    }

    db.upsertSpecimens(row.id, scanSpecimens(rootDir, speciesName));
    db.upsertPics(row.id, scanPics(rootDir, speciesName));

    return { hasSummary, specimenCount };
  } catch (err) { return { error: err.message }; }
});

// ── IPC: api-key (shared) ─────────────────────────────────────────────────────
// ── IPC: delete-species ───────────────────────────────────────────────────────
ipcMain.handle("delete-species", async (_e, rootDir, speciesName) => {
  try {
    const user       = requireUser();
    const speciesDir = path.join(rootDir, speciesName);
    db.deleteSpecies(user.id, speciesName, rootDir);
    if (fs.existsSync(speciesDir)) fs.rmSync(speciesDir, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle("get-output-root",    () => loadSettings().outputRoot || "");
ipcMain.handle("set-output-root",    (_e, v) => { const s=loadSettings(); s.outputRoot=v; saveSettings(s); return true; });
ipcMain.handle("get-api-key",       () => loadSettings().geminiApiKey   || "");
ipcMain.handle("get-auth-token",    () => loadSettings().authToken       || "");
ipcMain.handle("set-api-key",       (_e, v) => { const s=loadSettings(); s.geminiApiKey  =v; saveSettings(s); return true; });
ipcMain.handle("set-auth-token",    (_e, v) => { const s=loadSettings(); s.authToken      =v; saveSettings(s); return true; });

// VoucherVision + Red List option blocks (defaults merged so the UI always has
// a full set of fields to show/edit).
ipcMain.handle("get-vv-settings",      () => ({ ...VV_DEFAULTS, ...(loadSettings().vouchervision || {}) }));
ipcMain.handle("set-vv-settings",      (_e, partial) => {
  const s = loadSettings();
  s.vouchervision = { ...VV_DEFAULTS, ...(s.vouchervision || {}), ...(partial || {}) };
  saveSettings(s); return true;
});
ipcMain.handle("get-redlist-settings", () => ({ ...REDLIST_DEFAULTS, ...(loadSettings().redlist || {}) }));
ipcMain.handle("set-redlist-settings", (_e, partial) => {
  const s = loadSettings();
  s.redlist = { ...REDLIST_DEFAULTS, ...(s.redlist || {}), ...(partial || {}) };
  saveSettings(s); return true;
});

// ── IPC: browse-for-folder (generic folder picker, no auth required) ──────────
ipcMain.handle("browse-for-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"], title: "Select folder",
  });
  return result.canceled ? null : result.filePaths[0];
});

// ── IPC: create-species ───────────────────────────────────────────────────────
ipcMain.handle("create-species", async (_e, speciesName, imagePaths) => {
  try {
    const user       = requireUser();
    const settings   = loadSettings();
    const outputRoot = settings.outputRoot;
    if (!outputRoot) return { error: "No output root folder set. Add it in Settings." };

    const folderName = speciesName.trim().replace(/\s+/g, "_");
    const speciesDir = path.join(outputRoot, folderName);

    // Check for duplicate — folder exists on disk or already in DB
    const existingRow = db.getSpeciesByName(user.id, folderName, outputRoot);
    if (existingRow || fs.existsSync(speciesDir)) {
      return { error: `"${speciesName.trim()}" already exists. Please delete it first before creating a new entry with the same name.` };
    }

    const picsDir = path.join(speciesDir, "pics");
    fs.mkdirSync(picsDir, { recursive: true });

    // Copy images
    for (const src of imagePaths) {
      fs.copyFileSync(src, path.join(picsDir, path.basename(src)));
    }

    // Register in DB
    const row = db.upsertSpecies({
      userId: user.id,
      name: folderName,
      displayName: speciesName.trim(),
      rootDir: outputRoot,
      specimenCount: 0,
      hasSummary: false,
    });

    db.upsertPics(row.id, scanPics(outputRoot, folderName));

    return { ok: true, folderName, speciesDir, rootDir: outputRoot };
  } catch (err) {
    return { error: err.message };
  }
});

// ── IPC: open-external ───────────────────────────────────────────────────────
ipcMain.handle("open-external", (_e, url) => shell.openExternal(url));

// ── IPC: load-output-root ─────────────────────────────────────────────────────
// Returns only species that belong to the current user.
// Does NOT auto-register every folder on disk — species are created explicitly
// via create-species or by the first user who opened a folder.
ipcMain.handle("load-output-root", async () => {
  try {
    const user     = requireUser();
    const settings = loadSettings();
    const rootDir  = settings.outputRoot;
    if (!rootDir || !fs.existsSync(rootDir)) return { error: "Output root not set or not found." };

    // Only sync species already belonging to this user — refresh their file state
    const existing = db.getAllSpecies(user.id, rootDir);
    for (const row of existing) {
      const dirPath = path.join(rootDir, row.name);
      if (!fs.existsSync(dirPath)) continue;
      const hasSummary    = summaryExists(rootDir, row.name);
      const specimenCount = fs.readdirSync(dirPath)
        .filter(f => f.endsWith(".json") && !f.startsWith("red_list_summary")).length;
      const updatedRow = db.upsertSpecies({ userId: user.id, name: row.name, displayName: row.display_name, rootDir, specimenCount, hasSummary });
      if (hasSummary && !row.summary_text) {
        try {
          const data = readSummaryFile(rootDir, row.name);
          if (data) db.updateSummary(user.id, row.name, rootDir, data);
        } catch (_) {}
      }
      db.upsertSpecimens(updatedRow.id, scanSpecimens(rootDir, row.name));
      db.upsertPics(updatedRow.id, scanPics(rootDir, row.name));
    }

    const species = db.getAllSpecies(user.id, rootDir).map(r => ({
      name: r.name, displayName: r.display_name,
      hasSummary: r.has_summary === 1, specimenCount: r.specimen_count,
    }));

    return { rootDir, species };
  } catch (err) {
    return { error: err.message };
  }
});

// ── IPC: pipeline (Red List summaries) ────────────────────────────────────────
// Native Gemini HTTP path (gemini-client.js). Emits the "pipeline-event"
// messages the renderer consumes.
ipcMain.handle("run-pipeline", async (_e, rootDir, speciesName, language) => {
  if (activeRun) return { error: "Pipeline already running." };
  const settings = loadSettings();
  if (!settings.geminiApiKey) return { error: "No API key set. Add your Gemini API key in Settings." };
  try { await runRedlistNative(rootDir, speciesName || null, language || "English"); return { ok: true }; }
  catch (err) { return { error: err.message }; }
});

ipcMain.handle("cancel-pipeline", () => {
  if (activeRun) { activeRun.cancel = true; try { activeRun.controller.abort(); } catch (_) {} return true; }
  return false;
});

// ── IPC: copy-images-to-pics ──────────────────────────────────────────────────
// Adds images to an existing species, like create-species does for a new one.
// Only files whose name (stem) already has a transcription result (<stem>.json)
// are skipped, so re-adding never overwrites an image behind an existing result;
// anything without a result is copied and gets transcribed on the next run.
ipcMain.handle("copy-images-to-pics", async (_e, rootDir, speciesName, imagePaths) => {
  try {
    const speciesDir = path.join(rootDir, speciesName);
    const picsDir    = path.join(speciesDir, "pics");
    if (!fs.existsSync(picsDir)) fs.mkdirSync(picsDir, { recursive: true });

    const stemOf = (f) => path.basename(f, path.extname(f));
    const transcribed = new Set(
      fs.readdirSync(speciesDir).filter(f => f.endsWith(".json") && !f.startsWith("red_list_summary")).map(stemOf)
    );

    const copied = [], skipped = [];
    for (const src of imagePaths) {
      const name = path.basename(src);
      if (transcribed.has(stemOf(name))) { skipped.push(name); continue; }
      fs.copyFileSync(src, path.join(picsDir, name));
      copied.push(name);
    }
    return { ok: true, copied, skipped };
  } catch (err) {
    return { error: err.message };
  }
});

// ── IPC: pick-images ──────────────────────────────────────────────────────────
ipcMain.handle("pick-images", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select herbarium specimen images",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Images", extensions: ["jpg","jpeg","png","webp","tif","tiff","jfif","bmp","heic","heif","jp2"] }],
  });
  return result.canceled ? [] : result.filePaths;
});

// ── IPC: run-voucher-pipeline ─────────────────────────────────────────────────
// Native path: vouchervision-emulator/ (default) or the remote VoucherVisionGO
// client. Emits the "voucher-event" messages the renderer consumes
// (start / processing / complete / error / done / closed).

const VV_MIME = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".tif": "image/tiff", ".tiff": "image/tiff",
  ".jfif": "image/jpeg", ".heic": "image/heic", ".heif": "image/heif",
};

// Drop the huge base64 collage blobs before writing the response to disk — the
// main app displays the pics/ images directly and never uses the VV collages.
function stripVvBase64(dict) {
  const copy = { ...dict };
  if (copy.collage_info && typeof copy.collage_info === "object") {
    const { base64image_input_resized, base64image_text_collage, ...rest } = copy.collage_info;
    copy.collage_info = { ...rest, base64_stripped: true };
  }
  return copy;
}

async function runVoucherNative(rootDir, speciesName) {
  const send = (msg) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("voucher-event", msg); };
  const settings = loadSettings();
  const vv = buildVvConfig(settings);
  const useEmulator = vv.backend !== "remote";
  const emulatorCfg = useEmulator ? buildEmulatorConfig(vv) : null;

  if (useEmulator) {
    if (!vv.geminiApiKey) { send({ event: "fatal", message: "No Gemini API key set. Add it in Settings." }); send({ event: "closed", code: 1 }); return; }
  } else {
    if (!vv.apiKey)      { send({ event: "fatal", message: "No VoucherVision auth token set (authToken in settings.json)." }); send({ event: "closed", code: 1 }); return; }
    if (!vv.apiBaseUrl)  { send({ event: "fatal", message: "No VoucherVision server URL set (vouchervision.apiBaseUrl in settings)." }); send({ event: "closed", code: 1 }); return; }
  }
  const backendLabel = useEmulator ? `local emulator (${vv.engines} → ${vv.llmModel})` : "VoucherVisionGO server";

  const speciesDir = path.join(rootDir, speciesName);
  const picsDir    = path.join(speciesDir, "pics");
  if (!fs.existsSync(picsDir)) { send({ event: "fatal", message: `No pics/ folder found in ${speciesName}.` }); send({ event: "closed", code: 1 }); return; }

  if (!fs.readdirSync(picsDir).some(f => IMG_EXTS.includes(path.extname(f).toLowerCase()))) {
    send({ event: "fatal", message: `No images found in ${picsDir}` }); send({ event: "closed", code: 1 }); return;
  }

  const run = { type: "vv", cancel: false, controller: new AbortController() };
  activeRun = run;

  // TIFF / BMP / HEIC / JPEG 2000 get a <stem>.jpg copy that is transcribed instead.
  let images;
  try {
    images = await imageNormalize.normalizePics(picsDir, IMG_EXTS, {
      onWarn:      (message) => send({ event: "progress", status: "warn", message }),
      onConverted: (from, to) => send({ event: "log", message: `Converted ${from} → ${to}` }),
    });
  } catch (err) {
    images = [];
    send({ event: "progress", status: "warn", message: `Could not prepare images: ${err.message}` });
  }
  if (!images.length) {
    activeRun = null;
    send({ event: "fatal", message: "No usable images after processing." }); send({ event: "closed", code: 1 }); return;
  }

  // Images that already have a <stem>.json were transcribed on an earlier run
  // (or before more images were added): leave them alone.
  const already = images.filter(img => fs.existsSync(path.join(speciesDir, `${path.basename(img, path.extname(img))}.json`)));
  const skipped = already.length;
  images = images.filter(img => !already.includes(img));
  if (skipped) send({ event: "log", message: `Skipping ${skipped} already-transcribed image(s).` });
  if (!images.length) {
    activeRun = null;
    send({ event: "progress", status: "complete", message: `All ${skipped} image(s) are already transcribed — nothing new to process.` });
    send({ event: "done", succeeded: 0, failed: 0 });
    send({ event: "closed", code: 0 });
    return;
  }

  // Emulator: every image is launched at once; two shared limiters gate the
  // stages (resize ×prepConcurrency, Gemini calls ×geminiConcurrency) so OCR
  // calls for early images overlap with resizing of later ones.
  let n;
  if (useEmulator) {
    const prepN   = Math.max(1, Math.min(vv.prepConcurrency || 4, images.length));
    const geminiN = Math.max(1, Math.min(vv.geminiConcurrency || 4, images.length));
    emulatorCfg.prepLimit   = vvEmulator.createLimiter(prepN);
    emulatorCfg.geminiLimit = vvEmulator.createLimiter(geminiN);
    n = images.length;
  } else {
    n = Math.min(vv.concurrency || 4, images.length);
  }
  send({ event: "progress", status: "start", message: `Processing ${images.length} image(s)…` });
  send({ event: "log", message: `Backend: ${backendLabel}` });
  send({ event: "progress", status: "processing", message: `Transcribing ${images.length} image(s) with Gemini — this may take a few minutes…` });

  let ok = 0, fail = 0;
  const total = images.length;
  const finished = () => ok + fail;
  const cursor = { i: 0 };
  const worker = async () => {
    while (!run.cancel) {
      const idx = cursor.i++;
      if (idx >= images.length) break;
      const img  = images[idx];
      const stem = path.basename(img, path.extname(img));
      // Remote: one submit per worker, so announce each. Emulator: all are queued at once,
      // so only the per-image completion lines below are emitted.
      if (!useEmulator) send({ event: "progress", status: "processing", message: `[${idx + 1}/${total}] ${img}` });
      try {
        const imgPath = path.join(picsDir, img);
        const mimeType = VV_MIME[path.extname(img).toLowerCase()] || "application/octet-stream";
        const file = useEmulator
          ? { bytes: () => fs.promises.readFile(imgPath), filename: img, mimeType }  // read lazily inside the prep limiter
          : { bytes: fs.readFileSync(imgPath), filename: img, mimeType };
        const result = useEmulator
          ? await vvEmulator.processImage(file, emulatorCfg, run.controller.signal)
          : await vvClient.submit(vv, file, run.controller.signal);
        // Normalise formatted_json to an object (server may return a JSON string)
        // and write a per-image <stem>.json in the shape scanSpecimens() reads.
        let fmt = result.formatted_json;
        if (typeof fmt === "string") { try { fmt = JSON.parse(fmt); } catch (_) { /* leave */ } }
        const out = {
          ...stripVvBase64(result),
          filename: img,
          formatted_json: (fmt && typeof fmt === "object") ? fmt : {},
          ocr: typeof result.ocr === "string" ? result.ocr : (result.ocr == null ? "" : String(result.ocr)),
        };
        fs.writeFileSync(path.join(speciesDir, `${stem}.json`), JSON.stringify(out, null, 2));
        ok++;
        send({ event: "progress", status: "processing", message: `[${finished()}/${total}] ${img} — done ✓` });
      } catch (err) {
        if (run.cancel) break;
        fail++;
        send({ event: "progress", status: "warn", message: geminiClient.friendlyGeminiError(err, { model: vv.llmModel, filename: img }) });
      }
    }
  };

  await Promise.all(Array.from({ length: n }, () => worker()));

  activeRun = null;
  // The renderer logs "cancelled" itself; just close the stream.
  if (run.cancel) { send({ event: "closed", code: 1 }); return; }
  if (ok === 0 && skipped === 0) {
    // Nothing transcribed, ever: the renderer deletes the empty species (cleanup).
    send({ event: "progress", status: "complete", message: `No specimens could be transcribed (${fail} failed).` });
    send({ event: "done", succeeded: 0, failed: fail, cleanup: true });
    send({ event: "closed", code: 0 });
    return;
  }
  if (ok === 0) {
    // Only the newly added images failed; the species keeps its earlier specimens.
    send({ event: "error", message: `No new specimens could be transcribed (${fail} failed).` });
    send({ event: "closed", code: 1 });
    return;
  }
  send({ event: "progress", status: "complete", message: `Done — ${ok}/${total} ${skipped ? "new " : ""}specimen(s) transcribed successfully${fail ? `, ${fail} failed` : ""}` });
  send({ event: "done", succeeded: ok, failed: fail });
  send({ event: "closed", code: 0 });
}

ipcMain.handle("run-voucher-pipeline", async (_e, rootDir, speciesName) => {
  if (activeRun) return { error: "A pipeline is already running." };
  const settings = loadSettings();
  const vv = buildVvConfig(settings);
  if (vv.backend === "remote") {
    if (!settings.authToken) return { error: "No VoucherVision auth token set (authToken in settings.json)." };
  } else if (!settings.geminiApiKey) {
    return { error: "No Gemini API key set. Add it in Settings." };
  }
  try { await runVoucherNative(rootDir, speciesName); return { ok: true }; }
  catch (err) { return { error: err.message }; }
});

// ── IPC: GBIF import ──────────────────────────────────────────────────────────
// Follows the app convention: resolve the user via requireUser(), pass the
// renderer's current rootDir as the library scope, and convert thrown errors to
// { error } objects (never throw across IPC). setCapture is a main-process-only
// toggle for silent attachment-download capture.
ipcMain.handle("gbif:setCapture", (_e, on) => { gbifCapture.setCapturing(!!on); return { ok: true }; });

ipcMain.handle("gbif:getOccurrence", async (_e, rootDir, ref) => {
  try { return await gbifService.getOccurrence(requireUser(), rootDir, ref); }
  catch (err) { return { error: err.message }; }
});

ipcMain.handle("gbif:saveImport", async (_e, rootDir, ref, imageData) => {
  try { return await gbifService.saveImport(requireUser(), rootDir, ref, imageData); }
  catch (err) { return { error: err.message }; }
});

ipcMain.handle("gbif:list", async (_e, rootDir) => {
  try { return await gbifService.list(requireUser(), rootDir); }
  catch (err) { return { error: err.message }; }
});

ipcMain.handle("gbif:remove", async (_e, id) => {
  try { return gbifService.remove(requireUser(), id); }
  catch (err) { return { error: err.message }; }
});

ipcMain.handle("gbif:enumerateSearch", async (_e, rootDir, searchUrl, opts) => {
  try { return await gbifService.enumerateSearch(requireUser(), rootDir, searchUrl, opts || {}); }
  catch (err) { return { error: err.message }; }
});

ipcMain.handle("gbif:bookmark", async (_e, rootDir, url, label) => {
  try { return gbifService.bookmarkSearch(requireUser(), rootDir, url, label); }
  catch (err) { return { error: err.message }; }
});

ipcMain.handle("gbif:bookmarks", async (_e, rootDir) => {
  try { return gbifService.listBookmarks(requireUser(), rootDir); }
  catch (err) { return { error: err.message }; }
});

ipcMain.handle("gbif:removeBookmark", async (_e, id) => {
  try { return gbifService.removeBookmark(requireUser(), id); }
  catch (err) { return { error: err.message }; }
});
