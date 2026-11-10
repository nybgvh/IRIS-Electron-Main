// GBIF import: search herbarium specimen occurrences with images, or import by id/URL.
// Talks to the open GBIF JSON API; images are downloaded from the publishing institution's host.
const fs = require("fs");
const path = require("path");

const GBIF_API = "https://api.gbif.org/v1";
const UA = "Mozilla/5.0 (compatible; IRIS-IUCN/1.0; +https://github.com/nybgvh/IRIS-Electron-Main)";
const MAX_IMAGE_BYTES = 60 * 1024 * 1024;

function parseOccurrenceId(ref) {
  const s = String(ref == null ? "" : ref).trim();
  if (/^\d+$/.test(s)) return s;
  let m = s.match(/occurrence\/(\d+)/) || s.match(/[?&]entity=o_(\d+)/);
  return m ? m[1] : null;
}

async function fetchWithTimeout(url, opts = {}, ms = 30000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal, headers: { "User-Agent": UA, ...(opts.headers || {}) } }); }
  finally { clearTimeout(t); }
}

async function fetchJson(url) {
  const res = await fetchWithTimeout(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`GBIF request failed (${res.status}).`);
  return res.json();
}

function pickImageUrl(occ) {
  const media = Array.isArray(occ.media) ? occ.media : [];
  const m = media.find(x => x && x.identifier && /image/i.test(x.type || "")) || media.find(x => x && x.identifier);
  return m ? m.identifier : null;
}

// Find specimens of a species that have images. Returns [{id, scientificName, country, institution, imageUrl}]
async function searchBySpecies(name, limit = 20) {
  const q = new URLSearchParams({
    scientificName: String(name).replace(/_/g, " ").trim(),
    mediaType: "StillImage", basisOfRecord: "PRESERVED_SPECIMEN",
    limit: String(Math.min(Math.max(limit, 1), 100)),
  });
  const data = await fetchJson(`${GBIF_API}/occurrence/search?${q}`);
  return (data.results || []).map(o => ({
    id: String(o.key), scientificName: o.scientificName || null, country: o.country || null,
    institution: o.institutionCode || null, catalogNumber: o.catalogNumber || null, imageUrl: pickImageUrl(o),
  })).filter(r => r.imageUrl);
}

async function downloadImage(url) {
  const res = await fetchWithTimeout(url, { headers: { Accept: "image/*,*/*;q=0.8" }, redirect: "follow" }, 60000);
  if (!res.ok) throw new Error(`image host returned ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error("empty download");
  if (buf.length > MAX_IMAGE_BYTES) throw new Error("image exceeds 60 MB");
  try { await require("sharp")(buf, { limitInputPixels: false }).metadata(); }
  catch (_) { throw new Error("download was not a valid image — the host may have blocked it"); }
  return buf;
}

// Import occurrences into <speciesDir>/pics as GBIF_<id>.jpg and record citations in vv_run/gbif_sources.json
async function importOccurrences(speciesDir, refs, emit, signal) {
  const pics = path.join(speciesDir, "pics");
  fs.mkdirSync(pics, { recursive: true });
  const logPath = path.join(speciesDir, "vv_run", "gbif_sources.json");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  let log = {};
  try { log = JSON.parse(fs.readFileSync(logPath, "utf-8")); } catch (_) {}

  const sharp = require("sharp");
  let imported = 0, skipped = 0, failed = 0;
  for (let i = 0; i < refs.length; i++) {
    if (signal && signal.aborted) break;
    const id = parseOccurrenceId(refs[i]);
    const tag = `[${i + 1}/${refs.length}] GBIF ${id || refs[i]}`;
    if (!id) { emit({ status: "warn", message: `${tag} — not a valid occurrence id or URL, skipping.` }); failed++; continue; }
    const dest = path.join(pics, `GBIF_${id}.jpg`);
    if (fs.existsSync(dest)) { emit({ status: "processing", message: `${tag} — already imported, skipping.` }); skipped++; continue; }
    try {
      emit({ status: "processing", message: `${tag} — downloading…` });
      const occ = await fetchJson(`${GBIF_API}/occurrence/${id}`);
      const url = pickImageUrl(occ);
      if (!url) throw new Error("this occurrence has no image");
      const buf = await downloadImage(url);
      await sharp(buf, { limitInputPixels: false }).rotate().jpeg({ quality: 92 }).toFile(dest);
      let citation = `https://www.gbif.org/occurrence/${id}`;
      if (occ.datasetKey) {
        try { const ds = await fetchJson(`${GBIF_API}/dataset/${occ.datasetKey}`);
          if (ds.citation && ds.citation.text) citation = `${ds.citation.text} ${citation}`; } catch (_) {}
      }
      log[`GBIF_${id}`] = { gbif_id: id, occurrence_url: `https://www.gbif.org/occurrence/${id}`, image_url: url,
        scientific_name: occ.scientificName || null, catalog_number: occ.catalogNumber || null,
        country: occ.country || null, citation };
      imported++;
    } catch (e) {
      emit({ status: "warn", message: `${tag} — ${e.name === "AbortError" ? "timed out" : e.message}` });
      failed++;
    }
  }
  fs.writeFileSync(logPath, JSON.stringify(log, null, 2), "utf-8");
  return { imported, skipped, failed };
}

module.exports = { parseOccurrenceId, searchBySpecies, importOccurrences };
