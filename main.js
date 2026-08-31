const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs   = require("fs");
const { spawn, spawnSync } = require("child_process");
const db   = require("./database");
const gbifService  = require("./gbif-service");
const gbifCapture  = require("./gbif-capture");
const vvClient     = require("./vouchervision-client");
const geminiClient = require("./gemini-client");

let mainWindow;
let activeRun   = null; // { type, cancel, controller } while a native pipeline runs
let currentUser = null; // { id, username } while logged in

// ── VoucherVisionGO settings ──────────────────────────────────────────────────
// Prefilled with the experimental IRIS_Electron settings (see its .env.example).
// The API key is NOT stored here — the native client authenticates with the
// existing `authToken` setting ("VoucherVision Auth Token" in the Settings UI).
// These are seeded into the user-managed settings.json and are editable there.
const VV_DEFAULTS = {
  apiBaseUrl:       "https://vouchervision-go-738307415303.us-central1.run.app",
  endpoint:         "/process",
  prompt:           "SLTPvM_full.yaml",
  engines:          "gemini-3.1-flash-lite",
  llmModel:         "gemini-3.1-flash-lite",
  ocrOnly:          false,
  notebookMode:     false,
  skipLabelCollage: false,
  includeWfo:       true,
  includeCop90:     true,
  vertexProject:    "",
  vertexRegion:     "global",
  concurrency:      4,          // how many images submit at once
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

// ── Cross-platform Python resolution ────────────────────────────────────────
// Different OSes (and even different installers on the same OS) expose the
// Python interpreter under different command names. We probe a short list of
// candidates once, cache the winner, and reuse it for every pipeline spawn.
let cachedPythonCmd = null;

function resolvePythonCmd() {
  if (cachedPythonCmd) return cachedPythonCmd;

  const candidates = process.platform === "win32"
    ? ["python", "py", "python3"]
    : ["python3", "python"];

  for (const cmd of candidates) {
    try {
      const result = spawnSync(cmd, ["--version"], { stdio: "ignore" });
      if (!result.error && result.status === 0) {
        cachedPythonCmd = cmd;
        return cmd;
      }
    } catch (_) { /* try next candidate */ }
  }

  // Nothing found — fall back to the most common default so the resulting
  // error message ("Is Python installed and on PATH?") still makes sense.
  cachedPythonCmd = process.platform === "win32" ? "python" : "python3";
  return cachedPythonCmd;
}

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
  vv.apiKey = settings.authToken || "";
  return vv;
}

// Build the Red List config: seeded/edited settings plus the existing gemini key.
function buildRedlistConfig(settings) {
  const rl = { ...REDLIST_DEFAULTS, ...(settings.redlist || {}) };
  rl.apiKey = settings.geminiApiKey || "";
  return rl;
}

// ── Native Red List summary generation (ports pipeline.py) ────────────────────
const REDLIST_SECTION_KEYS = ["taxonomy", "geographic_range", "habitat", "ecology", "use_and_trade", "threats"];

// Same prompt the Python pipeline used; {language} and {records} are substituted.
const REDLIST_PROMPT_TEMPLATE = `
You are extracting Red List assessment information from herbarium specimen OCR records.

LANGUAGE REQUIREMENT — CRITICAL:
Write the entire output in {language}. All section text, narratives, labels, and any stated
unavailability must be in {language}. Do not mix languages.

Use only information present in the records. Do not invent information.

CRITICAL CITATION RULE:
Every specimen filename must be cited individually, each preceded by its own "source_image:" prefix.
CORRECT:  source_image: abc123, source_image: def456
WRONG:    source_image: abc123, def456

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
      const fmt = data.formatted_json || {};
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
        specimenDescription:      fmt.specimenDescription ?? null,
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
      if (!records.length) { send({ event: "progress", species: sp, status: "skip", message: "No specimen JSON files found" }); failed++; continue; }

      send({ event: "progress", species: sp, status: "generating", message: `Sending ${records.length} records to Gemini…` });
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
        send({ event: "error", species: sp, message: `JSON parse failed: ${e.message}. See _debug_response.txt.` });
        failed++; continue;
      }

      const output = {
        generated_at: new Date().toISOString(),
        model: rl.model, language: lang, species: sp, sections,
      };
      fs.writeFileSync(path.join(speciesDir, "red_list_summary_rd.json"), JSON.stringify(output, null, 2));
      if (user) { try { db.updateSummary(user.id, sp, rootDir, output); } catch (_) {} }

      send({ event: "done", species: sp });
      succeeded++;
    } catch (err) {
      if (run.cancel) break;
      send({ event: "error", species: sp, message: err.message });
      failed++;
    }
  }

  activeRun = null;
  send({ event: "finish", total: names.length, succeeded, failed });
  send({ event: "closed", code: run.cancel ? 1 : 0 });
}

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600,
    backgroundColor: "#0f1a0f",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true, // GBIF tab embeds gbif.org in a <webview>
    },
  });
  mainWindow.loadFile("index.html");
  gbifCapture.setup(mainWindow); // silent capture of attachment-style GBIF images
}

// TEMP (dev testing): ensure a known account exists so the dev-login hint in the
// UI works out of the box. Remove this and the #dev-login-hint element before release.
function seedDevAccount() {
  try {
    const res = db.createUser("dev", "devpass123");
    if (res && !res.error) console.log("[DEV] seeded test account dev / devpass123");
  } catch (_) { /* already exists — fine */ }
}

app.whenReady().then(async () => {
  await db.init(app.getPath("userData"));
  seedDevAccount();
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
const IMG_EXTS = [".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"];

function scanPics(rootDir, speciesName) {
  const picsDir = path.join(rootDir, speciesName, "pics");
  const map = {};
  if (!fs.existsSync(picsDir)) return map;
  for (const f of fs.readdirSync(picsDir)) {
    const ext = path.extname(f).toLowerCase();
    if (IMG_EXTS.includes(ext)) map[path.basename(f, ext)] = path.join(picsDir, f);
  }
  return map;
}

function scanSpecimens(rootDir, speciesName) {
  const dirPath = path.join(rootDir, speciesName);
  const specimens = [];
  for (const file of fs.readdirSync(dirPath).filter(f => f.endsWith(".json") && !f.startsWith("red_list_summary"))) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dirPath, file), "utf-8"));
      const fmt  = data.formatted_json || {};
      specimens.push({
        source_image:         path.basename(file, ".json"),
        filename:             file,
        scientific_name:      fmt.scientificName       || null,
        country:              fmt.country              || null,
        state_province:       fmt.stateProvince        || null,
        locality:             fmt.locality             || null,
        habitat:              fmt.habitat              || null,
        specimen_description: fmt.specimenDescription  || null,
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
    const picsDir    = path.join(speciesDir, "pics");

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
      const dirPath     = path.join(rootDir, row.name);
      if (!fs.existsSync(dirPath)) continue;
      const summaryJsonP = path.join(dirPath, "red_list_summary_rd.json");
      const summaryPath  = summaryJsonP;
      const hasSummary   = fs.existsSync(summaryPath);
      const specimenCount = fs.readdirSync(dirPath).filter(f => f.endsWith(".json") && !f.startsWith("red_list_summary")).length;

      db.upsertSpecies({ userId: user.id, name: row.name, displayName: row.display_name, rootDir, specimenCount, hasSummary });
      if (hasSummary && !row.summary_text) {
        try {
          const raw = fs.readFileSync(summaryPath, "utf-8");
          const data = summaryPath.endsWith(".json") ? JSON.parse(raw) : raw;
          db.updateSummary(user.id, row.name, rootDir, data);
        } catch (_) {}
      }
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
// NATIVE Gemini HTTP path — replaces the Python pipeline.py subprocess (commented
// out below), eliminating the last Python dependency. Emits the same
// "pipeline-event" messages the renderer already consumes.
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
ipcMain.handle("copy-images-to-pics", async (_e, rootDir, speciesName, imagePaths) => {
  try {
    const picsDir = path.join(rootDir, speciesName, "pics");
    if (!fs.existsSync(picsDir)) fs.mkdirSync(picsDir, { recursive: true });

    const copied = [];
    for (const src of imagePaths) {
      const dest = path.join(picsDir, path.basename(src));
      fs.copyFileSync(src, dest);
      copied.push(path.basename(src));
    }
    return { ok: true, copied };
  } catch (err) {
    return { error: err.message };
  }
});

// ── IPC: pick-images ──────────────────────────────────────────────────────────
ipcMain.handle("pick-images", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Select herbarium specimen images",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Images", extensions: ["jpg","jpeg","png","webp","tif","tiff"] }],
  });
  return result.canceled ? [] : result.filePaths;
});

// ── IPC: run-voucher-pipeline ─────────────────────────────────────────────────
// NATIVE VoucherVisionGO HTTP path — replaces the Python voucher_pipeline.py
// subprocess (commented out below), eliminating the Python VoucherVision
// dependency. Emits the same "voucher-event" NDJSON-shaped messages the renderer
// already consumes (start / processing / complete / error / done / closed).

const VV_MIME = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".webp": "image/webp", ".tif": "image/tiff", ".tiff": "image/tiff",
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

  if (!vv.apiKey)      { send({ event: "fatal", message: "No VoucherVision auth token set. Add it in Settings." }); send({ event: "closed", code: 1 }); return; }
  if (!vv.apiBaseUrl)  { send({ event: "fatal", message: "No VoucherVision server URL set (vouchervision.apiBaseUrl in settings)." }); send({ event: "closed", code: 1 }); return; }

  const speciesDir = path.join(rootDir, speciesName);
  const picsDir    = path.join(speciesDir, "pics");
  if (!fs.existsSync(picsDir)) { send({ event: "fatal", message: `No pics/ folder found in ${speciesName}.` }); send({ event: "closed", code: 1 }); return; }

  const images = fs.readdirSync(picsDir).filter(f => IMG_EXTS.includes(path.extname(f).toLowerCase()));
  if (!images.length) { send({ event: "fatal", message: `No images found in ${picsDir}` }); send({ event: "closed", code: 1 }); return; }

  const run = { type: "vv", cancel: false, controller: new AbortController() };
  activeRun = run;
  send({ event: "progress", status: "start", message: `Found ${images.length} images in pics/ — starting VoucherVision…` });

  let ok = 0, fail = 0;
  const cursor = { i: 0 };
  const worker = async () => {
    while (!run.cancel) {
      const idx = cursor.i++;
      if (idx >= images.length) break;
      const img  = images[idx];
      const stem = path.basename(img, path.extname(img));
      send({ event: "progress", status: "processing", message: `(${idx + 1}/${images.length}) ${img}…` });
      try {
        const bytes = fs.readFileSync(path.join(picsDir, img));
        const result = await vvClient.submit(
          vv,
          { bytes, filename: img, mimeType: VV_MIME[path.extname(img).toLowerCase()] || "application/octet-stream" },
          run.controller.signal
        );
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
      } catch (err) {
        if (run.cancel) break;
        fail++;
        send({ event: "progress", status: "error", message: `${img}: ${err.message}` });
      }
    }
  };

  const n = Math.min(vv.concurrency || 4, images.length);
  await Promise.all(Array.from({ length: n }, () => worker()));

  activeRun = null;
  if (run.cancel) { send({ event: "error", message: "Cancelled by user." }); send({ event: "closed", code: 1 }); return; }
  send({ event: "progress", status: "complete", message: `VoucherVision finished — ${ok} JSON file(s) generated${fail ? `, ${fail} failed` : ""}` });
  if (ok === 0) { send({ event: "fatal", message: `All ${images.length} image(s) failed.` }); send({ event: "closed", code: 1 }); return; }
  send({ event: "done" });
  send({ event: "closed", code: 0 });
}

ipcMain.handle("run-voucher-pipeline", async (_e, rootDir, speciesName) => {
  if (activeRun) return { error: "A pipeline is already running." };
  const settings = loadSettings();
  if (!settings.authToken) return { error: "No VoucherVision auth token set. Add it in Settings." };
  try { await runVoucherNative(rootDir, speciesName); return { ok: true }; }
  catch (err) { return { error: err.message }; }
});

/* ── LEGACY: Python voucher_pipeline.py subprocess (replaced by the native
 *    VoucherVisionGO HTTP client above). Kept commented for reference; remove
 *    voucher_pipeline.py and the `VoucherVision` pip requirement once confident.
 *
 * ipcMain.handle("run-voucher-pipeline", async (_e, rootDir, speciesName) => {
 *   const settings = loadSettings();
 *   if (!settings.authToken)      return { error: "No auth token set. Add it in Settings." };
 *   if (!settings.geminiApiKey)   return { error: "No Gemini API key set. Add it in Settings." };
 *   if (activeProcess)            return { error: "A pipeline is already running." };
 *
 *   const speciesDir = path.join(rootDir, speciesName);
 *   const scriptPath = path.join(__dirname, "voucher_pipeline.py");
 *   const args       = [scriptPath, speciesDir, settings.authToken, settings.geminiApiKey];
 *   const pythonCmd  = resolvePythonCmd();
 *
 *   return new Promise((resolve) => {
 *     let proc;
 *     try { proc = spawn(pythonCmd, args, { stdio: ["ignore", "pipe", "pipe"] }); }
 *     catch (err) { resolve({ error: `Could not start Python: ${err.message}` }); return; }
 *
 *     activeProcess = proc;
 *
 *     proc.stdout.on("data", (chunk) => {
 *       chunk.toString().split("\n").filter(Boolean).forEach(line => {
 *         try {
 *           const msg = JSON.parse(line);
 *           mainWindow.webContents.send("voucher-event", msg);
 *         } catch (_) {
 *           mainWindow.webContents.send("voucher-event", { event: "log", message: line });
 *         }
 *       });
 *     });
 *
 *     proc.stderr.on("data", chunk => {
 *       mainWindow.webContents.send("voucher-event", { event: "log", message: chunk.toString() });
 *     });
 *
 *     proc.on("close", code => {
 *       activeProcess = null;
 *       mainWindow.webContents.send("voucher-event", { event: "closed", code });
 *       resolve({ ok: true, code });
 *     });
 *
 *     proc.on("error", err => {
 *       activeProcess = null;
 *       resolve({ error: `Process error: ${err.message}` });
 *     });
 *   });
 * });
 */

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
