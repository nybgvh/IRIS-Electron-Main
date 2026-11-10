// PDF -> page images. pdf-to-img is ESM-only, so it is loaded with a dynamic import().
const fs = require("fs");
const path = require("path");

const MAX_PAGES = 10;    // keep a single import small
const DPI = 200;         // good for OCR and label reading without huge files

let pdfFn = null;
async function getPdf() {
  if (!pdfFn) pdfFn = (await import("pdf-to-img")).pdf;
  return pdfFn;
}

// Writes <outDir>/<pdf name>_p0001.jpg, _p0002.jpg ... Returns the file names written.
// onProgress({ done, total }) is called after each page.
async function pdfToJpgs(pdfPath, outDir, onProgress) {
  const sharp = require("sharp");
  sharp.cache(false);
  const stem = path.parse(pdfPath).name.replace(/\s+/g, "_");
  let doc;
  try { doc = await (await getPdf())(pdfPath, { scale: DPI / 72 }); }
  catch (e) { throw new Error(`Could not open "${path.basename(pdfPath)}" — it may be encrypted, corrupted or not a real PDF (${e.message}).`); }
  const total = Math.min(doc.length || MAX_PAGES, MAX_PAGES);
  if ((doc.length || 0) > MAX_PAGES) throw new Error(`"${path.basename(pdfPath)}" has ${doc.length} pages; the limit is ${MAX_PAGES} pages per PDF. Split it into parts of ${MAX_PAGES} pages or fewer.`);
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  let n = 0;
  for await (const png of doc) {
    n++;
    const name = `${stem}_p${String(n).padStart(4, "0")}.jpg`;
    await sharp(png).flatten({ background: "#ffffff" }).jpeg({ quality: 90 }).toFile(path.join(outDir, name));
    written.push(name);
    if (onProgress) onProgress({ file: path.basename(pdfPath), done: n, total });
  }
  if (!written.length) throw new Error(`"${path.basename(pdfPath)}" has no pages.`);
  return written;
}

module.exports = { pdfToJpgs, MAX_PAGES };
