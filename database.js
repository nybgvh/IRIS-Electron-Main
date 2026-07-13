/**
 * database.js — SQLite via sql.js (pure JS, no native compilation needed)
 */

const path    = require("path");
const fs      = require("fs");
const bcrypt  = require("bcryptjs");

let db     = null;
let dbPath = null;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS species (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name             TEXT NOT NULL,
    display_name     TEXT NOT NULL,
    root_dir         TEXT NOT NULL,
    specimen_count   INTEGER DEFAULT 0,
    has_summary      INTEGER DEFAULT 0,
    generated_at     TEXT,
    model            TEXT,
    language         TEXT,
    sec_taxonomy         TEXT,
    sec_geographic_range TEXT,
    sec_habitat          TEXT,
    sec_ecology          TEXT,
    sec_use_and_trade    TEXT,
    sec_threats          TEXT,
    created_at       TEXT DEFAULT (datetime('now')),
    updated_at       TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, name, root_dir)
  );

  CREATE TABLE IF NOT EXISTS specimens (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    species_id           INTEGER NOT NULL REFERENCES species(id) ON DELETE CASCADE,
    source_image         TEXT NOT NULL,
    filename             TEXT,
    scientific_name      TEXT,
    country              TEXT,
    state_province       TEXT,
    locality             TEXT,
    habitat              TEXT,
    specimen_description TEXT,
    min_elevation        REAL,
    max_elevation        REAL,
    collection_date      TEXT,
    decimal_latitude     REAL,
    decimal_longitude    REAL,
    gps_confidence       TEXT,
    additional_text      TEXT,
    ocr_text             TEXT
  );

  CREATE TABLE IF NOT EXISTS pics (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    species_id INTEGER NOT NULL REFERENCES species(id) ON DELETE CASCADE,
    stem       TEXT NOT NULL,
    file_path  TEXT NOT NULL,
    UNIQUE(species_id, stem)
  );

  CREATE INDEX IF NOT EXISTS idx_species_user     ON species(user_id);
  CREATE INDEX IF NOT EXISTS idx_specimens_species ON specimens(species_id);
  CREATE INDEX IF NOT EXISTS idx_pics_species      ON pics(species_id);
`;

// ── Persist ───────────────────────────────────────────────────────────────────
function persist() {
  if (!db || !dbPath) return;
  try { fs.writeFileSync(dbPath, Buffer.from(db.export())); }
  catch (err) { console.error("[DB] persist failed:", err.message); }
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init(userDataPath) {
  if (db) return db;
  let initSqlJs;
  try { initSqlJs = require("sql.js"); }
  catch (err) { console.error("[DB] sql.js not available:", err.message); return null; }

  const SQL = await initSqlJs();
  dbPath = path.join(userDataPath, "redlist.db");
  console.log("[DB] Opening:", dbPath);

  db = fs.existsSync(dbPath)
    ? new SQL.Database(fs.readFileSync(dbPath))
    : new SQL.Database();

  db.run(SCHEMA);
  persist();
  return db;
}

// ── Query helpers ─────────────────────────────────────────────────────────────
function run(sql, p = []) { db.run(sql, p); persist(); }

function get(sql, p = []) {
  const s = db.prepare(sql);
  s.bind(p);
  const row = s.step() ? s.getAsObject() : null;
  s.free();
  return row;
}

function all(sql, p = []) {
  const s = db.prepare(sql), rows = [];
  s.bind(p);
  while (s.step()) rows.push(s.getAsObject());
  s.free();
  return rows;
}

// ── Users ─────────────────────────────────────────────────────────────────────
function createUser(username, password) {
  const existing = get("SELECT id FROM users WHERE username=?", [username]);
  if (existing) return { error: "Username already taken." };
  const hash = bcrypt.hashSync(password, 10);
  run("INSERT INTO users (username, password_hash) VALUES (?,?)", [username, hash]);
  return get("SELECT id, username, created_at FROM users WHERE username=?", [username]);
}

function loginUser(username, password) {
  const user = get("SELECT * FROM users WHERE username=?", [username]);
  if (!user) return { error: "User not found." };
  if (!bcrypt.compareSync(password, user.password_hash)) return { error: "Incorrect password." };
  return { id: user.id, username: user.username, created_at: user.created_at };
}

function getUser(id) {
  return get("SELECT id, username, created_at FROM users WHERE id=?", [id]);
}

// ── Species (scoped to user) ──────────────────────────────────────────────────
function upsertSpecies({ userId, name, displayName, rootDir, specimenCount, hasSummary }) {
  run(`
    INSERT INTO species (user_id, name, display_name, root_dir, specimen_count, has_summary, updated_at)
    VALUES (?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(user_id, name, root_dir) DO UPDATE SET
      display_name=excluded.display_name,
      specimen_count=excluded.specimen_count,
      has_summary=excluded.has_summary,
      updated_at=datetime('now')
  `, [userId, name, displayName, rootDir, specimenCount, hasSummary ? 1 : 0]);
  return get("SELECT * FROM species WHERE user_id=? AND name=? AND root_dir=?", [userId, name, rootDir]);
}

function getAllSpecies(userId, rootDir) {
  return all("SELECT * FROM species WHERE user_id=? AND root_dir=? ORDER BY name", [userId, rootDir]);
}

function getSpeciesByName(userId, name, rootDir) {
  return get("SELECT * FROM species WHERE user_id=? AND name=? AND root_dir=?", [userId, name, rootDir]);
}

function updateSummary(userId, speciesName, rootDir, summaryData) {
  // Accept either a structured JSON object or raw string (legacy)
  if (typeof summaryData === 'string') {
    // Legacy plain text — store in taxonomy section as fallback
    run(`
      UPDATE species SET has_summary=1, sec_taxonomy=?, updated_at=datetime('now')
      WHERE user_id=? AND name=? AND root_dir=?
    `, [summaryData, userId, speciesName, rootDir]);
    return;
  }
  const s = summaryData.sections || {};
  run(`
    UPDATE species SET
      has_summary=1, generated_at=?, model=?, language=?,
      sec_taxonomy=?, sec_geographic_range=?, sec_habitat=?,
      sec_ecology=?, sec_use_and_trade=?, sec_threats=?,
      updated_at=datetime('now')
    WHERE user_id=? AND name=? AND root_dir=?
  `, [
    summaryData.generated_at || null,
    summaryData.model        || null,
    summaryData.language     || null,
    s.taxonomy               || null,
    s.geographic_range       || null,
    s.habitat                || null,
    s.ecology                || null,
    s.use_and_trade          || null,
    s.threats                || null,
    userId, speciesName, rootDir,
  ]);
}

function getSummary(userId, speciesName, rootDir) {
  const row = get("SELECT * FROM species WHERE user_id=? AND name=? AND root_dir=?",
    [userId, speciesName, rootDir]);
  if (!row || !row.has_summary) return null;
  return {
    generated_at: row.generated_at,
    model:        row.model,
    language:     row.language,
    species:      speciesName,
    sections: {
      taxonomy:         row.sec_taxonomy         || "",
      geographic_range: row.sec_geographic_range || "",
      habitat:          row.sec_habitat          || "",
      ecology:          row.sec_ecology          || "",
      use_and_trade:    row.sec_use_and_trade    || "",
      threats:          row.sec_threats          || "",
    },
  };
}

// ── Specimens ─────────────────────────────────────────────────────────────────
function upsertSpecimens(speciesId, specimens) {
  run("DELETE FROM specimens WHERE species_id=?", [speciesId]);
  for (const s of specimens) {
    run(`INSERT INTO specimens (
      species_id,source_image,filename,scientific_name,country,state_province,
      locality,habitat,specimen_description,min_elevation,max_elevation,
      collection_date,decimal_latitude,decimal_longitude,gps_confidence,
      additional_text,ocr_text
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      speciesId, s.source_image, s.filename, s.scientific_name, s.country,
      s.state_province, s.locality, s.habitat, s.specimen_description,
      s.min_elevation, s.max_elevation, s.collection_date,
      s.decimal_latitude, s.decimal_longitude, s.gps_confidence,
      s.additional_text, s.ocr_text,
    ]);
  }
}

function getSpecimens(speciesId) {
  return all("SELECT * FROM specimens WHERE species_id=?", [speciesId]);
}

// ── Pics ──────────────────────────────────────────────────────────────────────
function upsertPics(speciesId, picsMap) {
  run("DELETE FROM pics WHERE species_id=?", [speciesId]);
  for (const [stem, filePath] of Object.entries(picsMap)) {
    run("INSERT OR REPLACE INTO pics (species_id,stem,file_path) VALUES (?,?,?)",
      [speciesId, stem, filePath]);
  }
}

function getPicsMap(speciesId) {
  return Object.fromEntries(
    all("SELECT stem,file_path FROM pics WHERE species_id=?", [speciesId])
      .map(r => [r.stem, r.file_path])
  );
}

function getLastFolder(userId) {
  // Returns the most recently updated root_dir for this user
  const row = get(`
    SELECT root_dir FROM species
    WHERE user_id=?
    ORDER BY updated_at DESC LIMIT 1
  `, [userId]);
  return row ? row.root_dir : null;
}

function getUserFolders(userId) {
  // All distinct folders this user has opened, most recent first
  return all(`
    SELECT DISTINCT root_dir, MAX(updated_at) as last_used
    FROM species WHERE user_id=?
    GROUP BY root_dir
    ORDER BY last_used DESC
  `, [userId]);
}

function deleteSpecies(userId, name, rootDir) {
  run("DELETE FROM species WHERE user_id=? AND name=? AND root_dir=?", [userId, name, rootDir]);
}

module.exports = {
  init,
  createUser, loginUser, getUser,
  getLastFolder, getUserFolders,
  upsertSpecies, getAllSpecies, getSpeciesByName, updateSummary, getSummary,
  upsertSpecimens, getSpecimens,
  upsertPics, getPicsMap,
  deleteSpecies,
};
