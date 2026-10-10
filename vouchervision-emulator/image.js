/*
 * Image preparation for the OCR call.
 *
 * VoucherVisionGO resizes every upload to at most 5,200,000 pixels
 * (app.py process_uploaded_file_with_resize / resize_image_to_max_pixels) and
 * OCR_Gemini._prepare_image_for_api re-encodes it as RGB JPEG quality 95 and
 * sends it inline. We do the same with Electron's nativeImage so no native
 * imaging dependency is needed. (VVGO actually OCRs a YOLO label collage cut
 * from the resized image; the emulator OCRs the whole resized image.)
 */

const MAX_PIXELS   = 5200000;
const JPEG_QUALITY = 95;

let nativeImage = null;
try { ({ nativeImage } = require("electron")); } catch (_) { /* not running under Electron */ }

// Returns { data: Buffer, mimeType, width, height, resized }.
function prepareImage(bytes, mimeType) {
  const fallback = { data: bytes, mimeType: mimeType || "image/jpeg", width: 0, height: 0, resized: false };
  if (!nativeImage || typeof nativeImage.createFromBuffer !== "function") return fallback;

  let img;
  try { img = nativeImage.createFromBuffer(bytes); } catch (_) { return fallback; }
  if (!img || img.isEmpty()) return fallback; // e.g. TIFF/WebP — nativeImage decodes PNG/JPEG only

  const { width, height } = img.getSize();
  let w = width, h = height, resized = false;
  if (w * h > MAX_PIXELS) {
    // resize_image_to_max_pixels: scale by sqrt(max/current), then shrink until under the cap
    const scale = Math.sqrt(MAX_PIXELS / (w * h));
    w = Math.floor(width * scale); h = Math.floor(height * scale);
    while (w * h > MAX_PIXELS) { w -= 1; h = Math.floor(height * (w / width)); }
    img = img.resize({ width: w, height: h, quality: "best" });
    resized = true;
  }
  return { data: img.toJPEG(JPEG_QUALITY), mimeType: "image/jpeg", width: w, height: h, resized };
}

module.exports = { prepareImage, MAX_PIXELS, JPEG_QUALITY };
