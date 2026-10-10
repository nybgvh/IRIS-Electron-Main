/*
 * Headless smoke test for the VoucherVision emulator.
 *
 *   env -u ELECTRON_RUN_AS_NODE npm run smoke:vv -- <image> [out.json] [--model gemini-3.1-flash-lite]
 *
 * Runs as a windowless Electron app (so nativeImage is available), reads the
 * Gemini key from the app's settings.json, processes one image and writes the
 * response. If a sibling <stem>.json from the real VoucherVisionGO API exists
 * next to the image's species folder (pics/../<stem>.json), it compares the
 * top-level and formatted_json key sets.
 */

const { app } = require("electron");
const fs   = require("fs");
const path = require("path");
const { processImage } = require("./index");

const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".tif": "image/tiff", ".tiff": "image/tiff" };

function argValue(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

async function main() {
  const positional = process.argv.slice(2).filter((a, i, arr) => !a.startsWith("--") && !(arr[i - 1] || "").startsWith("--"));
  const imagePath = positional[0];
  if (!imagePath) throw new Error("usage: smoke.js <image> [out.json] [--model M] [--prompt P]");
  const outPath = positional[1] || path.join(process.cwd(), `${path.basename(imagePath, path.extname(imagePath))}.emulator.json`);

  const settingsPath = path.join(app.getPath("userData"), "settings.json");
  const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, "utf-8")) : {};
  const vv = settings.vouchervision || {};
  const model = argValue("--model", "gemini-3.1-flash-lite");
  const cfg = {
    apiKey: process.env.GEMINI_API_KEY || settings.geminiApiKey,
    apiBase: vv.geminiApiBase,
    apiVersion: vv.geminiApiVersion,
    engines: [model],
    llmModel: model,
    prompt: argValue("--prompt", vv.prompt || "SLTPvM_full.yaml"),
    ocrThinkingLevel: vv.ocrThinkingLevel || "low",
    llmThinkingLevel: vv.llmThinkingLevel || "low",
    timeoutMs: vv.submitTimeoutMs,
    maxRetries: vv.maxRetries,
  };
  console.log(`[smoke] image=${imagePath} model=${model} prompt=${cfg.prompt}`);

  const bytes = fs.readFileSync(imagePath);
  const t0 = Date.now();
  const res = await processImage({ bytes, filename: path.basename(imagePath), mimeType: MIME[path.extname(imagePath).toLowerCase()] }, cfg);
  console.log(`[smoke] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  fs.writeFileSync(outPath, JSON.stringify(res, null, 2));
  console.log(`[smoke] wrote ${outPath}`);

  const fj = res.formatted_json;
  console.log(`[smoke] ocr (${res.ocr.length} chars): ${res.ocr.slice(0, 160)}…`);
  console.log(`[smoke] formatted_json keys: ${Object.keys(fj).length}`);
  for (const k of ["catalogNumber", "scientificName", "collectedBy", "country", "decimalLatitude", "decimalLongitude", "inferredGPSConfidence"]) {
    console.log(`         ${k}: ${JSON.stringify(fj[k])}`);
  }

  // Compare against a real VVGO response if one is saved beside the species folder.
  const stem = path.basename(imagePath, path.extname(imagePath));
  const refPath = path.join(path.dirname(imagePath), "..", `${stem}.json`);
  if (fs.existsSync(refPath)) {
    const ref = JSON.parse(fs.readFileSync(refPath, "utf-8"));
    const diff = (a, b) => ({ missing: Object.keys(b).filter(k => !(k in a)), extra: Object.keys(a).filter(k => !(k in b)) });
    const top = diff(res, ref);
    const fjd = diff(fj, ref.formatted_json || {});
    const sameOrder = JSON.stringify(Object.keys(fj)) === JSON.stringify(Object.keys(ref.formatted_json || {}));
    console.log(`[smoke] vs ${refPath}`);
    console.log(`         top-level missing=${JSON.stringify(top.missing)} extra=${JSON.stringify(top.extra)}`);
    console.log(`         formatted_json missing=${JSON.stringify(fjd.missing)} extra=${JSON.stringify(fjd.extra)} sameOrder=${sameOrder}`);
    for (const k of ["catalogNumber", "scientificName", "country", "collectionDate"]) {
      console.log(`         ${k}: api=${JSON.stringify(ref.formatted_json[k])} emu=${JSON.stringify(fj[k])}`);
    }
  }
}

// Running a bare script makes Electron use "Electron" as the app name; point
// userData at the real app folder so settings.json (and the Gemini key) are found.
app.setName("iris-iucn");
app.setPath("userData", path.join(app.getPath("appData"), "iris-iucn"));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  let code = 0;
  try { await main(); } catch (err) { console.error("[smoke] FAILED:", err.stack || err.message); code = 1; }
  app.exit(code);
});
