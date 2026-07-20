const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs   = require("fs");
const { spawn, spawnSync } = require("child_process");
const db   = require("./database");

let mainWindow;
let activeProcess = null;
let currentUser   = null; // { id, username } while logged in

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

// ── Window ────────────────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600,
    backgroundColor: "#0f1a0f",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
  });
  mainWindow.loadFile("index.html");
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

// ── IPC: pipeline ─────────────────────────────────────────────────────────────
ipcMain.handle("run-pipeline", async (_e, rootDir, speciesName, language) => {
  const settings = loadSettings();
  if (!settings.geminiApiKey) return { error: "No API key set. Add your Gemini API key in Settings." };
  if (activeProcess)          return { error: "Pipeline already running." };

  const user       = requireUser ? currentUser : null;
  const scriptPath = path.join(__dirname, "pipeline.py");
  const args       = [scriptPath, rootDir, settings.geminiApiKey];
  if (speciesName) args.push(speciesName);
  args.push(language || "English");

  const pythonCmd = resolvePythonCmd();

  return new Promise((resolve) => {
    let proc;
    try { proc = spawn(pythonCmd, args, { stdio: ["ignore", "pipe", "pipe"] }); }
    catch (err) { resolve({ error: `Could not start Python: ${err.message}` }); return; }

    activeProcess = proc;

    proc.stdout.on("data", (chunk) => {
      chunk.toString().split("\n").filter(Boolean).forEach(line => {
        try {
          const msg = JSON.parse(line);
          if (msg.event === "done" && msg.species && user) {
            try {
              const jsonPath = path.join(rootDir, msg.species, "red_list_summary_rd.json");
              const txtPath  = path.join(rootDir, msg.species, "red_list_summary_rd.txt");
              if (fs.existsSync(jsonPath)) {
                db.updateSummary(user.id, msg.species, rootDir, JSON.parse(fs.readFileSync(jsonPath, "utf-8")));
              } else if (fs.existsSync(txtPath)) {
                db.updateSummary(user.id, msg.species, rootDir, fs.readFileSync(txtPath, "utf-8"));
              }
            } catch (_) {}
          }
          mainWindow.webContents.send("pipeline-event", msg);
        } catch (_) {}
      });
    });

    proc.stderr.on("data", chunk => {
      mainWindow.webContents.send("pipeline-event", { event: "stderr", message: chunk.toString() });
    });

    proc.on("close", code => {
      activeProcess = null;
      mainWindow.webContents.send("pipeline-event", { event: "closed", code });
      resolve({ ok: true, code });
    });

    proc.on("error", err => {
      activeProcess = null;
      resolve({ error: `Process error: ${err.message}. Is Python installed and on PATH?` });
    });
  });
});

ipcMain.handle("cancel-pipeline", () => {
  if (activeProcess) { activeProcess.kill(); activeProcess = null; return true; }
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
ipcMain.handle("run-voucher-pipeline", async (_e, rootDir, speciesName) => {
  const settings = loadSettings();
  if (!settings.authToken)      return { error: "No auth token set. Add it in Settings." };
  if (!settings.geminiApiKey)   return { error: "No Gemini API key set. Add it in Settings." };
  if (activeProcess)            return { error: "A pipeline is already running." };

  const speciesDir = path.join(rootDir, speciesName);
  const scriptPath = path.join(__dirname, "voucher_pipeline.py");
  const args       = [scriptPath, speciesDir, settings.authToken, settings.geminiApiKey];
  const pythonCmd  = resolvePythonCmd();

  return new Promise((resolve) => {
    let proc;
    try { proc = spawn(pythonCmd, args, { stdio: ["ignore", "pipe", "pipe"] }); }
    catch (err) { resolve({ error: `Could not start Python: ${err.message}` }); return; }

    activeProcess = proc;

    proc.stdout.on("data", (chunk) => {
      chunk.toString().split("\n").filter(Boolean).forEach(line => {
        try {
          const msg = JSON.parse(line);
          mainWindow.webContents.send("voucher-event", msg);
        } catch (_) {
          // verbose output from VoucherVision — forward as log line
          mainWindow.webContents.send("voucher-event", { event: "log", message: line });
        }
      });
    });

    proc.stderr.on("data", chunk => {
      mainWindow.webContents.send("voucher-event", { event: "log", message: chunk.toString() });
    });

    proc.on("close", code => {
      activeProcess = null;
      mainWindow.webContents.send("voucher-event", { event: "closed", code });
      resolve({ ok: true, code });
    });

    proc.on("error", err => {
      activeProcess = null;
      resolve({ error: `Process error: ${err.message}` });
    });
  });
});
