// GBIF helpers (main process). The GBIF tab embeds gbif.org in a <webview>; images are downloaded
// THROUGH that browser session (institutions often block plain server requests), and the bytes are
// handed here to be saved. This module only talks to GBIF's open JSON API (metadata, search) and
// writes files.
const fs = require("fs");
const path = require("path");

const GBIF_API = "https://api.gbif.org/v1";
const OCC_BASE = "https://www.gbif.org/occurrence";
const UA = "Mozilla/5.0 (compatible; IRIS-IUCN/1.0)";
const ENUM_MAX = 500;
const ENUM_PAGE = 300;
const MAX_IMAGE_BYTES = 60 * 1024 * 1024;

// gbif.org's default taxonomy (Catalogue of Life XR) uses alphanumeric taxon keys; the API only
// resolves them when told which checklist to use.
const COL_XR_CHECKLIST = "7ddf754f-d193-4cc9-b351-99906754a03b";
const TAXON_KEY_PARAMS = new Set(["taxonKey","taxonKeys","acceptedTaxonKey","speciesKey","genusKey",
  "familyKey","orderKey","classKey","phylumKey","kingdomKey","subgenusKey"]);

function parseOccurrenceId(ref) {
  const s = String(ref == null ? "" : ref).trim();
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/occurrence\/(\d+)/) || s.match(/[?&]entity=o_(\d+)/);
  return m ? m[1] : null;
}

async function fetchJson(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 30000);
  try {
    const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": UA }, signal: ctl.signal });
    if (!res.ok) throw new Error(`GBIF request failed (${res.status}).`);
    return await res.json();
  } catch (e) {
    throw new Error(e.name === "AbortError" ? "GBIF request timed out." : e.message);
  } finally { clearTimeout(t); }
}

function pickImageUrl(occ) {
  const media = Array.isArray(occ.media) ? occ.media : [];
  const m = media.find(x => x && x.identifier && /image/i.test(x.type || "")) || media.find(x => x && x.identifier);
  return m ? m.identifier : null;
}

function summarize(occ) {
  return {
    id: String(occ.key), imageUrl: pickImageUrl(occ), scientificName: occ.scientificName || null,
    country: occ.country || null, institution: occ.institutionCode || null, catalogNumber: occ.catalogNumber || null,
  };
}

// Translate a gbif.org search/gallery URL into an api.gbif.org occurrence search URL.
function buildSearchApiUrl(searchUrl, { limit, offset }) {
  const web = new URL(searchUrl);
  const api = new URL(`${GBIF_API}/occurrence/search`);
  const DROP = new Set(["view", "entity", "offset", "limit", "dwca_extension"]);
  let alnum = false, hasChecklist = false;
  for (const [k, v] of web.searchParams) {
    if (DROP.has(k) || k.startsWith("_")) continue;
    if (k === "checklistKey") hasChecklist = true;
    if (TAXON_KEY_PARAMS.has(k) && /[a-z]/i.test(v)) alnum = true;
    api.searchParams.append(k, v);
  }
  if (alnum && !hasChecklist) api.searchParams.set("checklistKey", COL_XR_CHECKLIST);
  api.searchParams.set("mediaType", "StillImage");
  api.searchParams.set("limit", String(limit));
  api.searchParams.set("offset", String(offset));
  return api.toString();
}

// One occurrence (the specimen currently open in the browser).
async function lookup(ref) {
  const id = parseOccurrenceId(ref);
  if (!id) throw new Error("Open a specimen on GBIF (click an image) first.");
  return summarize(await fetchJson(`${GBIF_API}/occurrence/${id}`));
}

// Up to `max` imaged specimens from the search currently open in the browser.
async function enumerateSearch(searchUrl, max) {
  if (!/^https?:\/\//i.test(String(searchUrl || ""))) throw new Error("Open a GBIF search (gallery) first.");
  const cap = Math.min(Math.max(parseInt(max, 10) || 20, 1), ENUM_MAX);
  const out = [];
  let offset = 0, total = 0, end = false;
  while (out.length < cap && !end && offset <= 100000) {
    const page = await fetchJson(buildSearchApiUrl(searchUrl, { limit: Math.min(ENUM_PAGE, cap - out.length), offset }));
    total = page.count || 0;
    for (const occ of page.results || []) {
      const s = summarize(occ);
      if (s.imageUrl) out.push(s);
      if (out.length >= cap) break;
    }
    end = !!page.endOfRecords || !(page.results || []).length;
    offset += ENUM_PAGE;
  }
  return { total, results: out };
}

// Save browser-downloaded image bytes into <speciesDir>/pics/GBIF_<id>.jpg and log the citation.
async function saveImage(speciesDir, id, dataUrl) {
  const sharp = require("sharp");
  sharp.cache(false);
  const buf = Buffer.from(String(dataUrl || "").replace(/^data:[^,]*,/, ""), "base64");
  if (!buf.length) throw new Error("No image data received.");
  if (buf.length > MAX_IMAGE_BYTES) throw new Error("Image exceeds 60 MB.");
  const pics = path.join(speciesDir, "pics");
  fs.mkdirSync(pics, { recursive: true });
  const dest = path.join(pics, `GBIF_${id}.jpg`);
  try { await sharp(buf, { limitInputPixels: false }).rotate().jpeg({ quality: 92 }).toFile(dest); }
  catch (_) { throw new Error("The download was not a valid image — the host may have blocked it."); }

  // Citation + metadata (best effort — never fails the import)
  try {
    const occ = await fetchJson(`${GBIF_API}/occurrence/${id}`);
    let citation = `${OCC_BASE}/${id}`;
    if (occ.datasetKey) {
      try { const ds = await fetchJson(`${GBIF_API}/dataset/${occ.datasetKey}`);
        if (ds.citation && ds.citation.text) citation = `${ds.citation.text} ${citation}`; } catch (_) {}
    }
    const logPath = path.join(speciesDir, "vv_run", "gbif_sources.json");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    let log = {}; try { log = JSON.parse(fs.readFileSync(logPath, "utf-8")); } catch (_) {}
    log[`GBIF_${id}`] = { gbif_id: id, occurrence_url: `${OCC_BASE}/${id}`, image_url: pickImageUrl(occ),
      scientific_name: occ.scientificName || null, catalog_number: occ.catalogNumber || null,
      country: occ.country || null, citation };
    fs.writeFileSync(logPath, JSON.stringify(log, null, 2), "utf-8");
  } catch (_) {}
  return { file: path.basename(dest) };
}

module.exports = { parseOccurrenceId, lookup, enumerateSearch, saveImage, buildSearchApiUrl };
