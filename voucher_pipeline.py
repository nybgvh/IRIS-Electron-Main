"""
IRIS Voucher Pipeline
Spawned by the Electron app. Copies images to pics/, runs VoucherVision,
then streams progress via stdout as JSON lines.

Usage: python voucher_pipeline.py <species_dir> <auth_token> <gemini_api_key>
"""

import sys
import json
import shutil
from pathlib import Path

# ── Stdout helpers ────────────────────────────────────────────────────────────
def emit(event, **kwargs):
    print(json.dumps({"event": event, **kwargs}), flush=True)

def emit_progress(status, message=""):
    emit("progress", status=status, message=message)

def emit_error(message):
    emit("error", message=message)

def emit_done():
    emit("done")

# ── Args ──────────────────────────────────────────────────────────────────────
if len(sys.argv) < 4:
    emit("fatal", message="Usage: voucher_pipeline.py <species_dir> <auth_token> <gemini_api_key>")
    sys.exit(1)

species_dir    = Path(sys.argv[1])
auth_token     = sys.argv[2]
gemini_api_key = sys.argv[3]

if not species_dir.is_dir():
    emit("fatal", message=f"Species directory not found: {species_dir}")
    sys.exit(1)

pics_dir = species_dir / "pics"

# ── Dependency check ──────────────────────────────────────────────────────────
try:
    from VoucherVision import process_vouchers
except ImportError:
    emit("fatal", message="VoucherVision not installed. Run: pip install VoucherVision")
    sys.exit(1)

# ── Count images ──────────────────────────────────────────────────────────────
IMG_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".tif", ".tiff"}
images = [f for f in pics_dir.iterdir() if f.suffix.lower() in IMG_EXTS] if pics_dir.exists() else []

if not images:
    emit("fatal", message=f"No images found in {pics_dir}")
    sys.exit(1)

emit_progress("start", f"Found {len(images)} images in pics/ — starting VoucherVision…")

# ── Run VoucherVision ─────────────────────────────────────────────────────────
try:
    emit_progress("processing", "Sending images to VoucherVision (this may take a while)…")

    process_vouchers(
        server="https://vouchervision-go-738307415303.us-central1.run.app/",
        output_dir=str(species_dir) + "/",
        directory=str(pics_dir) + "/",
        prompt="SLTPvM_geolocate.yaml",
        llm_model="gemini-3.1-pro-preview",
        verbose=True,
        save_to_xlsx=True,
        auth_token=auth_token,
        gemini_api_key=gemini_api_key,
    )
except Exception as e:
    emit_error(f"VoucherVision error: {e}")
    sys.exit(1)

# ── Count output JSONs ────────────────────────────────────────────────────────
json_files = list(species_dir.glob("*.json"))
emit_progress("complete", f"VoucherVision finished — {len(json_files)} JSON files generated")
emit_done()
