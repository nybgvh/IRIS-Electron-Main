"""
IRIS Voucher Pipeline — Direct Gemini Vision
Sends herbarium images directly to Gemini with the VoucherVision prompt.
No LeafMachine2, no VoucherVision library, no PyTorch required.

Usage: python voucher_pipeline.py <species_dir> <gemini_api_key>
"""

import sys
import os
import json
import logging
import warnings
warnings.filterwarnings("ignore")
logging.getLogger("google.genai").setLevel(logging.ERROR)
logging.getLogger("google.ai.generativelanguage").setLevel(logging.ERROR)
logging.getLogger("google.api_core").setLevel(logging.ERROR)
logging.disable(logging.WARNING)
import base64
import re
from pathlib import Path

# ── Stdout helpers ────────────────────────────────────────────────────────────
def emit(event, **kwargs):
    print(json.dumps({"event": event, **kwargs}), flush=True)

def emit_progress(status, message=""):
    emit("progress", status=status, message=message)

def emit_error(message):
    emit("error", message=message)

def emit_done(**kwargs):
    emit("done", **kwargs)

# ── Args ──────────────────────────────────────────────────────────────────────
if len(sys.argv) < 3:
    emit("fatal", message="Usage: voucher_pipeline.py <species_dir> <gemini_api_key>")
    sys.exit(1)

species_dir    = Path(sys.argv[1]).resolve()
gemini_api_key = sys.argv[2]

if not species_dir.is_dir():
    emit("fatal", message=f"Species directory not found: {species_dir}")
    sys.exit(1)

pics_dir = species_dir / "pics"
IMG_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"}
images   = sorted([
    f for f in pics_dir.iterdir()
    if f.suffix.lower() in IMG_EXTS
]) if pics_dir.exists() else []

if not images:
    emit("fatal", message=f"No images found in {pics_dir}")
    sys.exit(1)

# ── Dependencies ──────────────────────────────────────────────────────────────
try:
    from google import genai
    from google.genai import types
except ImportError:
    emit("fatal", message="google-genai not installed. Run: pip install google-genai")
    sys.exit(1)

try:
    from PIL import Image as PILImage
except ImportError:
    emit("fatal", message="Pillow not installed. Run: pip install Pillow")
    sys.exit(1)

# ── Convert and resize images ─────────────────────────────────────────────────
# Raise Pillow's decompression bomb limit for large herbarium scans
PILImage.MAX_IMAGE_PIXELS = None  # remove limit entirely

MAX_PIXELS = 4096 * 4096  # ~16MP — sufficient for Gemini, avoids timeouts

converted = 0
jpg_images = []
for img_path in images:
    target = img_path.with_suffix(".jpg") if img_path.suffix.lower() != ".jpg" else img_path
    try:
        with PILImage.open(img_path) as im:
            im_rgb = im.convert("RGB")
            # Resize if too large
            w, h = im_rgb.size
            if w * h > MAX_PIXELS:
                scale = (MAX_PIXELS / (w * h)) ** 0.5
                im_rgb = im_rgb.resize((int(w * scale), int(h * scale)), PILImage.LANCZOS)
            if img_path.suffix.lower() not in {".jpg", ".jpeg"} or not target.exists():
                im_rgb.save(target, "JPEG", quality=92)
                if img_path != target:
                    converted += 1
            else:
                # Re-save existing JPG if it needs resizing
                orig_w, orig_h = w, h
                if orig_w * orig_h > MAX_PIXELS:
                    im_rgb.save(target, "JPEG", quality=92)
        jpg_images.append(target)
    except Exception as e:
        emit_progress("warn", f"Could not process {img_path.name}: {e}")

images = jpg_images
if not images:
    emit("fatal", message="No usable images after processing.")
    sys.exit(1)

emit_progress("start", f"Processing {len(images)} image(s)…")

# ── Gemini setup ──────────────────────────────────────────────────────────────
client = genai.Client(api_key=gemini_api_key)

# ── Prompt ────────────────────────────────────────────────────────────────────
SYSTEM_PROMPT = """You are a specialist in digitising natural history museum herbarium specimen labels.

Your task is to extract all text from this herbarium specimen image and return it as a structured JSON object.

INSTRUCTIONS:
1. Extract all visible text from labels, barcodes, and annotations on the specimen sheet.
2. Map the extracted text to the appropriate JSON fields below.
3. Handwritten text appears between guillemet quotes «like this» in OCR — include the content only, not the markers.
4. Stricken/redacted text appears between section signs §like this§ — include in identificationHistory only.
5. Leave fields as empty strings if the information is not present.
6. Only return a valid JSON object — no explanation, no markdown fences.
7. After extracting fields, if decimalLatitude and decimalLongitude are empty, infer coordinates from the locality information using your geographic knowledge. Only infer if specific enough (city, landmark, park, intersection). Use 'verbatim' in inferredGPSConfidence if coordinates appear on the label, 'high' for specific locations, 'medium' for counties, 'low' for states/provinces, 'na' if too vague.

Return this exact JSON structure:
{
  "catalogNumber": "",
  "scientificName": "",
  "genus": "",
  "specificEpithet": "",
  "scientificNameAuthorship": "",
  "collectedBy": "",
  "collectorNumber": "",
  "identifiedBy": "",
  "identifiedDate": "",
  "identifiedConfidence": "",
  "identifiedRemarks": "",
  "identificationHistory": "",
  "verbatimCollectionDate": "",
  "collectionDate": "",
  "collectionDateEnd": "",
  "habitat": "",
  "specimenDescription": "",
  "cultivated": "",
  "continent": "",
  "country": "",
  "stateProvince": "",
  "county": "",
  "locality": "",
  "verbatimCoordinates": "",
  "decimalLatitude": "",
  "decimalLongitude": "",
  "inferredGPSConfidence": "",
  "minimumElevationInMeters": "",
  "maximumElevationInMeters": "",
  "elevationUnits": "",
  "multipleBarcodes": "",
  "additionalText": ""
}"""

# ── Process each image ────────────────────────────────────────────────────────
emit_progress("processing", f"Transcribing {len(images)} image(s) with Gemini…")

output_dir = species_dir / "vv_run" / "Transcription" / "Individual"
output_dir.mkdir(parents=True, exist_ok=True)

succeeded = 0
failed    = 0

for img_path in images:
    stem = img_path.stem
    out_path = output_dir / f"{stem}.json"

    if out_path.exists():
        succeeded += 1
        continue

    try:
        # Load image
        with PILImage.open(img_path) as im:
            img_rgb = im.convert("RGB")

        # Send to Gemini
        response = client.models.generate_content(
            model="gemini-3.1-pro-preview",
            contents=[SYSTEM_PROMPT, img_rgb],
            config=types.GenerateContentConfig(
                http_options=types.HttpOptions(timeout=300000)
            ),
        )

        raw = response.text.strip()

        # Strip markdown fences if present
        raw = re.sub(r'^```(?:json)?\s*', '', raw, flags=re.IGNORECASE)
        raw = re.sub(r'\s*```\s*$', '', raw)
        raw = raw.strip()

        parsed = json.loads(raw)

        # Wrap in the formatted_json structure that the rest of IRIS expects
        output = {
            "filename":      img_path.name,
            "source_image":  stem,
            "ocr":           raw,
            "formatted_json": parsed,
        }

        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(output, f, indent=2, ensure_ascii=False)

        # Also copy to species_dir root so pipeline.py finds it
        root_out = species_dir / f"{stem}.json"
        with open(root_out, "w", encoding="utf-8") as f:
            json.dump(output, f, indent=2, ensure_ascii=False)

        succeeded += 1

    except Exception as e:
        err_str = str(e)
        if "429" in err_str or "RESOURCE_EXHAUSTED" in err_str:
            msg = (f"Quota exceeded for {img_path.name} — "
                   f"gemini-3.1-pro-preview requires billing enabled on your Google account. "
                   f"Go to aistudio.google.com to enable billing.")
        elif "401" in err_str or "UNAUTHENTICATED" in err_str:
            msg = f"Invalid API key for {img_path.name} — check your Gemini API key in Settings."
        elif "404" in err_str or "not found" in err_str.lower():
            msg = f"Model not available for {img_path.name} — check your API key has access to gemini-3.1-pro-preview."
        elif "504" in err_str or "DEADLINE_EXCEEDED" in err_str:
            msg = f"Timeout processing {img_path.name} — image may be too large. Try a smaller image."
        else:
            msg = f"Failed {img_path.name}: {err_str[:120]}"
        emit_progress("warn", msg)
        failed += 1

total = succeeded + failed
emit_progress("complete",
    f"Done — {succeeded}/{total} specimen(s) transcribed successfully"
    + (f", {failed} failed" if failed else ""))

emit_done(succeeded=succeeded, failed=failed)
