/*
 * GBIF import service (main process).
 *
 * The renderer's GBIF tab embeds gbif.org in a <webview>. GBIF sits behind
 * Cloudflare bot-detection, and — critically — occurrence images are NOT hosted
 * by GBIF but by the publishing institutions (e.g. ngpherbaria.org). A
 * server-side fetch of those images looks like a bot and gets blocked. So the
 * IMAGE bytes must be pulled through the user's real browser session inside the
 * webview (which has already cleared Cloudflare and carries the right
 * cookies/headers) — the renderer navigates a hidden webview to the image URL,
 * reads the bytes with a same-origin fetch, and hands them to saveImport().
 *
 * This service only ever talks to GBIF's open JSON API (api.gbif.org), which is
 * not behind the challenge and never touches the institution's image host:
 *   getOccurrence()  → media identifier (image URL) + citation + metadata
 *   saveImport()     → re-fetch authoritative metadata, take the browser-fetched
 *                      image bytes, save the file + a GBIF library row
 *
 * Ported from IRIS_Electron/src/server/services/gbif-service.js, rewired to this
 * app's sql.js `database.js` and the filesystem (no projects/sources, no sharp).
 * GBIF data is scoped to the current output-root folder (`rootDir`) + user — a
 * shared "library" per output folder, the analog of the source app's project.
 */

const fs   = require("fs");
const path = require("path");
const db   = require("./database");

const GBIF_API = "https://api.gbif.org/v1";
const OCC_BASE = "https://gbif.org/occurrence";
const MAX_IMAGE_BYTES = 60 * 1024 * 1024; // 60 MB safety cap
const FETCH_TIMEOUT_MS = 30000;
const GBIF_DIRNAME = "_gbif"; // subfolder of rootDir where images are stored

// Accept a bare id, a gbif.org/occurrence/{id} URL, or a search URL carrying
// entity=o_{id} (the gallery's "selected occurrence" param).
function parseOccurrenceId(ref) {
  if (ref == null) return null;
  const s = String(ref).trim();
  if (/^\d+$/.test(s)) return s;
  let m = s.match(/occurrence\/(\d+)/);
  if (m) return m[1];
  m = s.match(/[?&]entity=o_(\d+)/);
  if (m) return m[1];
  return null;
}

async function fetchJson(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: ctl.signal });
    if (!res.ok) throw new Error(`GBIF request failed (${res.status}).`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Pick the best image media entry from a GBIF occurrence.
function pickImageUrl(occ) {
  const media = Array.isArray(occ.media) ? occ.media : [];
  const img = media.find(m => m && m.identifier && /image/i.test(m.type || ""))
    || media.find(m => m && m.identifier);
  return img ? img.identifier : null;
}

// Fetch occurrence (+ its dataset for the citation) and flatten to the fields
// we store / preview. The citation matches gbif.org's "please cite" box:
//   <dataset citation text> <occurrence URL>
async function fetchMeta(id) {
  const occ = await fetchJson(`${GBIF_API}/occurrence/${id}`);
  const imageUrl = pickImageUrl(occ);
  const occurrenceUrl = `${OCC_BASE}/${id}`;

  let datasetTitle = "", datasetDoi = "", citationText = "";
  if (occ.datasetKey) {
    try {
      const ds = await fetchJson(`${GBIF_API}/dataset/${occ.datasetKey}`);
      datasetTitle = ds.title || "";
      datasetDoi = ds.doi || "";
      citationText = (ds.citation && ds.citation.text) || "";
    } catch (_) { /* citation stays minimal */ }
  }
  const citation = citationText ? `${citationText} ${occurrenceUrl}` : occurrenceUrl;

  return {
    occ,
    meta: {
      gbif_id: id,
      occurrence_url: occurrenceUrl,
      image_url: imageUrl,
      has_image: !!imageUrl,
      citation,
      scientific_name: occ.scientificName || null,
      dataset_key: occ.datasetKey || null,
      dataset_title: datasetTitle || null,
      dataset_doi: datasetDoi || null,
      catalog_number: occ.catalogNumber || null,
      country: occ.country || null,
      latitude: occ.decimalLatitude ?? null,
      longitude: occ.decimalLongitude ?? null,
    },
  };
}

function requireRoot(rootDir) {
  if (!rootDir || !String(rootDir).trim()) {
    throw new Error("No output folder is open. Set an Output Root Folder in Settings first.");
  }
  return String(rootDir);
}

/*
 * Preview an occurrence before importing: returns the flattened metadata AND
 * the image URL the renderer must download through the browser. `ref` may be an
 * id, occurrence URL, or a gallery URL with entity=o_{id}.
 */
async function getOccurrence(user, rootDir, ref) {
  const root = requireRoot(rootDir);
  const id = parseOccurrenceId(ref);
  if (!id) {
    throw new Error("No GBIF occurrence selected. Open a specimen on GBIF (click an image), then Add.");
  }
  const { meta } = await fetchMeta(id);
  const existing = db.findGbifByGbifId(user.id, root, id);
  return { ...meta, duplicate: !!existing };
}

/*
 * Commit an import. The image bytes were downloaded by the renderer THROUGH THE
 * WEBVIEW (browser session), so this never fetches the institution's image
 * host. Metadata is re-fetched from api.gbif.org so what we store is
 * authoritative (not whatever the renderer passed). Idempotent per library.
 */
async function saveImport(user, rootDir, ref, imageData) {
  const root = requireRoot(rootDir);
  const id = parseOccurrenceId(ref);
  if (!id) throw new Error("Invalid GBIF occurrence id.");

  const existing = db.findGbifByGbifId(user.id, root, id);
  if (existing) return { ...existing, duplicate: true };

  const buffer = decodeImage(imageData);
  if (!buffer || !buffer.length) {
    throw new Error("No image data was captured from the page — try again after the image finishes loading.");
  }
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error("Image exceeds the 60 MB limit.");
  // Reject non-images (e.g. an HTML "Request Rejected" page a bot-blocking host
  // returned) BEFORE storing, so a broken item is never created in the library.
  if (!isImage(buffer)) {
    throw new Error(`The download for GBIF ${id} was not a valid image — the host likely blocked it.`);
  }

  const { occ, meta } = await fetchMeta(id);

  const gbifDir = path.join(root, GBIF_DIRNAME);
  fs.mkdirSync(gbifDir, { recursive: true });
  const filePath = path.join(gbifDir, `GBIF_${id}.jpg`);
  fs.writeFileSync(filePath, buffer);

  const row = db.createGbifSource({
    user_id: user.id,
    root_dir: root,
    gbif_id: id,
    file_path: filePath,
    occurrence_url: meta.occurrence_url,
    image_url: meta.image_url,
    citation: meta.citation,
    scientific_name: meta.scientific_name,
    dataset_key: meta.dataset_key,
    dataset_title: meta.dataset_title,
    dataset_doi: meta.dataset_doi,
    publisher: null,
    catalog_number: meta.catalog_number,
    country: meta.country,
    latitude: meta.latitude,
    longitude: meta.longitude,
    raw_json: JSON.stringify(occ),
  });

  return { ...row, imported: true };
}

// Accept a data: URL, a bare base64 string, or a byte array from the renderer.
function decodeImage(imageData) {
  if (!imageData) return null;
  if (Buffer.isBuffer(imageData)) return imageData;
  if (imageData instanceof Uint8Array || Array.isArray(imageData)) return Buffer.from(imageData);
  if (typeof imageData === "string") {
    const b64 = imageData.replace(/^data:[^,]*,/, "");
    return Buffer.from(b64, "base64");
  }
  return null;
}

// Magic-byte sniff — replaces sharp's decode check. Rejects HTML "blocked"
// pages and other non-raster payloads before anything is written to the library.
function isImage(buf) {
  if (!buf || buf.length < 12) return false;
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true;
  // GIF87a / GIF89a
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return true;
  // WEBP: "RIFF"...."WEBP"
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true;
  // TIFF (little- and big-endian)
  if (buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) return true;
  if (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a) return true;
  return false;
}

function list(user, rootDir) {
  const root = requireRoot(rootDir);
  return db.listGbifSources(user.id, root);
}

// --- bulk enumeration (download all images in a search) --------------------

const ENUM_MAX = 500;    // hard cap — the gallery can match millions, and large
                         // summaries degrade; 500 is the max per import.
const ENUM_PAGE = 300;   // GBIF's max page size

// gbif.org's CURRENT default taxonomy is Catalogue of Life XR, whose taxon keys
// are alphanumeric (e.g. taxonKey=4J2JZ = Pinus torreyana) — NOT the classic
// integer GBIF-backbone keys. The occurrence API only resolves those keys when
// told which checklist to use (`checklistKey`); without it the default backbone
// is queried and an alphanumeric key silently matches nothing (count 0).
const COL_XR_CHECKLIST = "7ddf754f-d193-4cc9-b351-99906754a03b";
const TAXON_KEY_PARAMS = new Set([
  "taxonKey", "taxonKeys", "acceptedTaxonKey", "speciesKey", "genusKey",
  "familyKey", "orderKey", "classKey", "phylumKey", "kingdomKey", "subgenusKey",
]);

// Translate a gbif.org gallery/search URL into an api.gbif.org occurrence
// search URL: forward the filter params verbatim, drop UI-only ones, add the
// CoL-XR checklistKey when the taxon filter is one of its alphanumeric keys,
// force StillImage so only imaged records come back, and page.
function buildSearchApiUrl(searchUrl, { limit, offset }) {
  const web = new URL(searchUrl);
  const api = new URL(`${GBIF_API}/occurrence/search`);
  const DROP = new Set(["view", "entity", "offset", "limit", "dwca_extension"]);
  let alphanumericTaxon = false;
  let hasChecklist = false;
  for (const [k, v] of web.searchParams) {
    if (DROP.has(k) || k.startsWith("_")) continue; // '_CfChlFTk' (Cloudflare) etc.
    if (k === "checklistKey") hasChecklist = true;
    if (TAXON_KEY_PARAMS.has(k) && /[a-z]/i.test(v)) alphanumericTaxon = true;
    api.searchParams.append(k, v);
  }
  // Non-numeric taxon key ⇒ it's a CoL-XR key; tell the API to use that taxonomy.
  if (alphanumericTaxon && !hasChecklist) api.searchParams.set("checklistKey", COL_XR_CHECKLIST);
  api.searchParams.set("mediaType", "StillImage"); // only records that have an image
  api.searchParams.set("limit", String(limit));
  api.searchParams.set("offset", String(offset));
  return api.toString();
}

/*
 * Enumerate every imaged occurrence matching the current GBIF search, by
 * paginating the open JSON API (NOT by scraping the gallery). Returns the id +
 * image URL for each, flagged with whether it's already imported, plus the true
 * total and whether we hit the ENUM_MAX cap. The renderer then downloads each
 * image through the browser session and calls saveImport().
 */
async function enumerateSearch(user, rootDir, searchUrl, opts = {}) {
  const root = requireRoot(rootDir);
  if (!/^https?:\/\//i.test(String(searchUrl || ""))) {
    throw new Error("Open a GBIF search (gallery) first.");
  }
  const max = Math.min(opts.max || ENUM_MAX, ENUM_MAX); // never exceed the hard cap
  const out = [];
  let offset = 0, total = 0, endOfRecords = false;
  while (out.length < max && !endOfRecords && offset <= 100000) {
    const page = await fetchJson(buildSearchApiUrl(searchUrl, { limit: ENUM_PAGE, offset }));
    total = page.count || 0;
    for (const occ of (page.results || [])) {
      const img = pickImageUrl(occ);
      if (!img) continue;
      out.push({ gbif_id: String(occ.key), image_url: img, scientific_name: occ.scientificName || null });
      if (out.length >= max) break;
    }
    endOfRecords = !!page.endOfRecords;
    offset += ENUM_PAGE;
  }
  const existing = new Set(db.listGbifSources(user.id, root).map(r => String(r.gbif_id)));
  for (const o of out) o.already_imported = existing.has(o.gbif_id);
  return { total, occurrences: out, capped: total > out.length };
}

// --- saved GBIF searches (bookmarks) ---------------------------------------

// Build a short human label from a gbif.org search URL (query, then a couple of
// notable filters) so the bookmarks dropdown is readable.
function deriveBookmarkLabel(url) {
  try {
    const u = new URL(url);
    const p = u.searchParams;
    const q = p.get("q");
    if (q) return `“${q}”`;
    const parts = [];
    const taxon = p.get("taxon_key") || p.get("taxonKey");
    if (taxon) parts.push(`taxon ${taxon}`);
    if (p.get("country")) parts.push(p.get("country"));
    const bor = p.get("basisOfRecord") || p.get("basis_of_record");
    if (bor) parts.push(String(bor).toLowerCase().replace(/_/g, " "));
    if (parts.length) return `GBIF: ${parts.join(", ")}`;
    return `${u.hostname}${u.pathname}`;
  } catch (_) { return String(url); }
}

function bookmarkSearch(user, rootDir, url, label) {
  const root = requireRoot(rootDir);
  const u = String(url || "").trim();
  if (!/^https?:\/\//i.test(u)) throw new Error("Nothing to bookmark yet — browse GBIF first.");
  const existing = db.findGbifBookmarkByUrl(user.id, root, u);
  if (existing) return { ...existing, duplicate: true };
  const finalLabel = (label && String(label).trim()) || deriveBookmarkLabel(u);
  return db.createGbifBookmark({ user_id: user.id, root_dir: root, url: u, label: finalLabel });
}

function listBookmarks(user, rootDir) {
  const root = requireRoot(rootDir);
  return db.listGbifBookmarks(user.id, root);
}

function removeBookmark(user, id) {
  const row = db.findGbifBookmarkById(user.id, id);
  if (!row) throw new Error("Bookmark not found.");
  db.removeGbifBookmark(user.id, id);
  return { ok: true };
}

// Remove a GBIF reference row and its stored image file.
function remove(user, id) {
  const row = db.getGbifSource(user.id, id);
  if (!row) throw new Error("GBIF reference not found.");
  if (row.file_path) { try { fs.unlinkSync(row.file_path); } catch (_) { /* already gone */ } }
  db.removeGbifSource(user.id, id);
  return { ok: true };
}

module.exports = {
  getOccurrence, saveImport, list, remove, parseOccurrenceId, enumerateSearch,
  bookmarkSearch, listBookmarks, removeBookmark,
  _buildSearchApiUrl: buildSearchApiUrl, // test seam
};
