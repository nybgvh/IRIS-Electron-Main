const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs   = require("fs");
const db   = require("./database");

let mainWindow;
let currentUser = null; // { id, username } while logged in

// ── Settings (shared API key) ─────────────────────────────────────────────────
const settingsPath = path.join(app.getPath("userData"), "settings.json");
function loadSettings() {
  try { if (fs.existsSync(settingsPath)) return JSON.parse(fs.readFileSync(settingsPath, "utf-8")); } catch (_) {}
  return {};
}
function saveSettings(data) {
  try { fs.writeFileSync(settingsPath, JSON.stringify(data, null, 2)); } catch (_) {}
}

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600,
    backgroundColor: "#0f1a0f",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: process.platform === "darwin" ? { x: 14, y: 20 } : undefined,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.loadFile("index.html");
  if (process.platform === "darwin") {
    mainWindow.webContents.on("did-finish-load", () => {
      mainWindow.webContents.executeJavaScript(
        'document.body.classList.add("platform-mac")'
      );
    });
  }
}

app.whenReady().then(async () => {
  await db.init(app.getPath("userData"));
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

ipcMain.handle("browse-for-folder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"], title: "Select folder",
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("get-output-root",    () => loadSettings().outputRoot || "");
ipcMain.handle("set-output-root",    (_e, v) => { const s=loadSettings(); s.outputRoot=v; saveSettings(s); return true; });
ipcMain.handle("get-api-key",       () => loadSettings().geminiApiKey   || "");
ipcMain.handle("set-api-key",       (_e, v) => { const s=loadSettings(); s.geminiApiKey  =v; saveSettings(s); return true; });

// ── IPC: local VoucherVision setup ─────────────────────────────────────────────

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
    filters: [{ name: "Images", extensions: ["jpg","jpeg","png","webp","tif","tiff","jfif","bmp","heic","heif","jp2"] }],
  });
  return result.canceled ? [] : result.filePaths;
});

// ── IPC: open-external ───────────────────────────────────────────────────────
ipcMain.handle("open-external", (_e, url) => shell.openExternal(url));

// ── IPC: load-output-root ─────────────────────────────────────────────────────
ipcMain.handle("load-output-root", async () => {
  try {
    const user    = requireUser();
    const settings = loadSettings();
    const rootDir  = settings.outputRoot;
    if (!rootDir || !fs.existsSync(rootDir)) return { error: "Output root not set or not found." };

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
  } catch (err) { return { error: err.message }; }
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

    for (const src of imagePaths) {
      fs.copyFileSync(src, path.join(picsDir, path.basename(src)));
    }

    const row = db.upsertSpecies({
      userId: user.id, name: folderName,
      displayName: speciesName.trim(),
      rootDir: outputRoot, specimenCount: 0, hasSummary: false,
    });
    db.upsertPics(row.id, scanPics(outputRoot, folderName));

    return { ok: true, folderName, speciesDir, rootDir: outputRoot };
  } catch (err) { return { error: err.message }; }
});


// ── Pipelines run in-process (pure JavaScript, no Python) ─────────────────────
const pipelines = require("./pipelines");
const gbif      = require("./gbif");
let abortCtl = null;
const send = (channel, msg) => { try { mainWindow.webContents.send(channel, msg); } catch (_) {} };

// ── IPC: run-pipeline (Red List summary) ──────────────────────────────────────
ipcMain.handle("run-pipeline", async (_e, rootDir, speciesName, language) => {
  const settings = loadSettings();
  if (!settings.geminiApiKey) return { error: "No Gemini API key set. Add it in Settings." };
  if (abortCtl)               return { error: "A pipeline is already running." };
  const user = currentUser;
  abortCtl = new AbortController();
  try {
    await pipelines.runSummary({
      outputRoot: rootDir, species: speciesName, apiKey: settings.geminiApiKey, language,
      signal: abortCtl.signal,
      emit: (msg) => {
        if (msg.event === "done" && msg.species && user) {
          try {
            const data = readSummaryFile(rootDir, msg.species);
            if (data) db.updateSummary(user.id, msg.species, rootDir, data);
          } catch (_) {}
        }
        send("pipeline-event", msg);
      },
    });
  } catch (err) {
    send("pipeline-event", { event: "error", species: speciesName, message: `Unexpected error: ${err.message}` });
  } finally {
    abortCtl = null;
    send("pipeline-event", { event: "closed", code: 0 });
  }
  return { ok: true, code: 0 };
});

// ── IPC: cancel-pipeline ──────────────────────────────────────────────────────
ipcMain.handle("cancel-pipeline", () => {
  if (abortCtl) { abortCtl.abort(); return true; }
  return false;
});

// ── IPC: run-voucher-pipeline (transcription: Gemini or Tesseract) ────────────
ipcMain.handle("run-voucher-pipeline", async (_e, rootDir, speciesName, mode, gbifRefs) => {
  const settings = loadSettings();
  const isOcr = mode === "ocr";
  if (!isOcr && !settings.geminiApiKey) return { error: "No Gemini API key set. Add it in Settings." };
  if (abortCtl) return { error: "A pipeline is already running." };
  abortCtl = new AbortController();
  try {
    if (gbifRefs && gbifRefs.length) {
      send("voucher-event", { event: "progress", status: "start", message: `Importing ${gbifRefs.length} specimen image(s) from GBIF…` });
      const r = await gbif.importOccurrences(path.join(rootDir, speciesName), gbifRefs,
        (m) => send("voucher-event", { event: "progress", ...m }), abortCtl.signal);
      send("voucher-event", { event: "progress", status: "processing",
        message: `GBIF: ${r.imported} imported${r.skipped ? `, ${r.skipped} already present` : ""}${r.failed ? `, ${r.failed} failed` : ""}` });
    }
    if (abortCtl.signal.aborted) throw new Error("Cancelled");
    await pipelines.runTranscription({
      speciesDir: path.join(rootDir, speciesName), apiKey: settings.geminiApiKey, mode,
      signal: abortCtl.signal, emit: (msg) => send("voucher-event", msg),
    });
  } catch (err) {
    send("voucher-event", { event: "fatal", message: `Unexpected error: ${err.message}` });
  } finally {
    abortCtl = null;
    send("voucher-event", { event: "closed", code: 0 });
  }
  return { ok: true, code: 0 };
});

// ── IPC: GBIF ─────────────────────────────────────────────────────────────────
ipcMain.handle("gbif-search", async (_e, name, limit) => {
  try { return { results: await gbif.searchBySpecies(name, limit || 20) }; }
  catch (err) { return { error: `GBIF search failed: ${err.message}` }; }
});
ipcMain.handle("gbif-import", async (_e, rootDir, speciesName, refs) => {
  try {
    const res = await gbif.importOccurrences(path.join(rootDir, speciesName), refs || [],
      (m) => send("voucher-event", { event: "progress", ...m }));
    return res;
  } catch (err) { return { error: `GBIF import failed: ${err.message}` }; }
});

ipcMain.handle("voucher-open-run-log", () => {
  const p = voucherRunLogPath();
  if (fs.existsSync(p)) shell.showItemInFolder(p);
  return { path: p, exists: fs.existsSync(p) };
});
