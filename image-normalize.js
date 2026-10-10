/*
 * Image normalization for pics/ (main process).
 *
 * Gemini accepts JPEG, PNG, WebP and HEIC/HEIF, and Chromium (the thumbnails and
 * the lightbox) can display JPEG, PNG, WebP and BMP. Herbarium scans often arrive
 * as TIFF or JPEG 2000, and phone photos as HEIC. Like the former
 * voucher_pipeline.py, every image in one of those formats gets a <stem>.jpg copy
 * next to it (original kept, longest edge scaled to stay within 16 MP, quality 92),
 * and transcription uses the copy.
 *
 * Decoders are pure JS / WASM so the same code can run in a browser build later:
 *   TIFF  utif2              BMP  bmp-js
 *   HEIC  heic-decode        JP2  @cornerstonejs/codec-openjpeg
 * Pixels are converted to BGRA and encoded with Electron's nativeImage.
 */

const fs   = require("fs");
const path = require("path");

const MAX_PIXELS   = 4096 * 4096; // ~16 MP, same cap as voucher_pipeline.py
const JPEG_QUALITY = 92;

// Formats that get a JPEG copy, and the decoder for each.
const CONVERT_EXTS = new Set([".tif", ".tiff", ".bmp", ".heic", ".heif", ".jp2"]);
// Formats Chromium can display directly (preferred for thumbnails).
const DISPLAYABLE_EXTS = new Set([".jpg", ".jpeg", ".jfif", ".png", ".webp", ".bmp", ".gif"]);

let nativeImage = null;
try { ({ nativeImage } = require("electron")); } catch (_) { /* not running under Electron */ }

// ── Decoders: each returns { width, height, bgra: Buffer } ───────────────────

function rgbaToBgra(rgba) {
  const out = Buffer.allocUnsafe(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    out[i] = rgba[i + 2]; out[i + 1] = rgba[i + 1]; out[i + 2] = rgba[i]; out[i + 3] = 255;
  }
  return out;
}

function decodeTiff(buf) {
  const UTIF = require("utif2");
  const ifds = UTIF.decode(buf);
  if (!ifds.length) throw new Error("no images in TIFF");
  // Multi-page TIFFs: use the largest page (scanners sometimes put a thumbnail first).
  let page = ifds[0];
  for (const ifd of ifds) {
    UTIF.decodeImage(buf, ifd);
    if ((ifd.width || 0) * (ifd.height || 0) > (page.width || 0) * (page.height || 0)) page = ifd;
  }
  if (!page.data) UTIF.decodeImage(buf, page);
  return { width: page.width, height: page.height, bgra: rgbaToBgra(UTIF.toRGBA8(page)) };
}

function decodeBmp(buf) {
  const bmp = require("bmp-js");
  const { width, height, data } = bmp.decode(buf); // ABGR byte order
  const out = Buffer.allocUnsafe(width * height * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = data[i + 1]; out[i + 1] = data[i + 2]; out[i + 2] = data[i + 3]; out[i + 3] = 255;
  }
  return { width, height, bgra: out };
}

async function decodeHeic(buf) {
  const decode = require("heic-decode");
  const { width, height, data } = await decode({ buffer: buf });
  return { width, height, bgra: rgbaToBgra(data) };
}

let openjpegPromise = null;
function openjpeg() {
  if (!openjpegPromise) {
    const factory = require("@cornerstonejs/codec-openjpeg/decodewasmjs");
    // Silence the codec's [INFO] lines on stdout.
    openjpegPromise = factory({ print: () => {}, printErr: () => {} });
  }
  return openjpegPromise;
}

async function decodeJp2(buf) {
  const oj  = await openjpeg();
  const dec = new oj.J2KDecoder();
  try {
    dec.getEncodedBuffer(buf.length).set(buf);
    dec.decode();
    const { width, height, bitsPerSample, componentCount } = dec.getFrameInfo();
    const raw = dec.getDecodedBuffer();
    const bytesPerSample = bitsPerSample > 8 ? 2 : 1;
    const samples = bytesPerSample === 2 ? new Uint16Array(raw.buffer, raw.byteOffset, raw.length / 2) : raw;
    const shift = Math.max(0, bitsPerSample - 8);
    const s = (i) => (bytesPerSample === 2 ? samples[i] >> shift : samples[i]);
    const out = Buffer.allocUnsafe(width * height * 4);
    for (let p = 0, i = 0; p < width * height; p++, i += componentCount) {
      const r = s(i), g = componentCount >= 3 ? s(i + 1) : r, b = componentCount >= 3 ? s(i + 2) : r;
      out[p * 4] = b; out[p * 4 + 1] = g; out[p * 4 + 2] = r; out[p * 4 + 3] = 255;
    }
    return { width, height, bgra: out };
  } finally {
    try { dec.delete(); } catch (_) {}
  }
}

async function decodeToBgra(buf, ext) {
  switch (ext) {
    case ".tif": case ".tiff": return decodeTiff(buf);
    case ".bmp":               return decodeBmp(buf);
    case ".heic": case ".heif": return decodeHeic(buf);
    case ".jp2":               return decodeJp2(buf);
    default: throw new Error(`no decoder for ${ext}`);
  }
}

// ── Encoding ──────────────────────────────────────────────────────────────────

function encodeJpeg({ width, height, bgra }) {
  if (!nativeImage) throw new Error("JPEG encoding requires Electron (nativeImage)");
  let img = nativeImage.createFromBitmap(bgra, { width, height });
  if (img.isEmpty()) throw new Error("could not build image from decoded pixels");
  if (width * height > MAX_PIXELS) {
    const scale = Math.sqrt(MAX_PIXELS / (width * height));
    img = img.resize({ width: Math.floor(width * scale), height: Math.floor(height * scale), quality: "best" });
  }
  return img.toJPEG(JPEG_QUALITY);
}

// ── Public API ────────────────────────────────────────────────────────────────

// Make sure every convertible image in picsDir has a <stem>.jpg copy, then return
// the list of file names to transcribe: one per stem, the JPEG copy standing in
// for its original. `onWarn(message)` is called for files that cannot be read.
async function normalizePics(picsDir, imgExts, { onWarn = () => {}, onConverted = () => {} } = {}) {
  const files = fs.readdirSync(picsDir).filter(f => imgExts.includes(path.extname(f).toLowerCase())).sort();
  const byStem = new Map();
  for (const f of files) {
    const ext  = path.extname(f).toLowerCase();
    const stem = path.basename(f, path.extname(f));
    if (!CONVERT_EXTS.has(ext)) {
      // A real JPEG/PNG/WebP wins over a convertible original with the same stem.
      if (!byStem.has(stem) || CONVERT_EXTS.has(path.extname(byStem.get(stem)).toLowerCase())) byStem.set(stem, f);
      continue;
    }
    const jpgName = `${stem}.jpg`;
    const jpgPath = path.join(picsDir, jpgName);
    if (!fs.existsSync(jpgPath)) {
      try {
        const decoded = await decodeToBgra(fs.readFileSync(path.join(picsDir, f)), ext);
        fs.writeFileSync(jpgPath, encodeJpeg(decoded));
        onConverted(f, jpgName);
      } catch (e) {
        onWarn(`Could not process ${f}: ${e.message}`);
        continue;
      }
    }
    byStem.set(stem, jpgName);
  }
  return [...byStem.values()].sort();
}

// For a stem → path map: is `candidate` a better thumbnail than `current`?
function preferForDisplay(current, candidate) {
  if (!current) return true;
  const cur = DISPLAYABLE_EXTS.has(path.extname(current).toLowerCase());
  const can = DISPLAYABLE_EXTS.has(path.extname(candidate).toLowerCase());
  return can && !cur;
}

module.exports = { normalizePics, preferForDisplay, decodeToBgra, encodeJpeg, CONVERT_EXTS, DISPLAYABLE_EXTS, MAX_PIXELS, JPEG_QUALITY };
