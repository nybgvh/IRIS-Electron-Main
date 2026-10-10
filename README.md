# IRIS — IUCN Red List Information System

An Electron desktop app for browsing herbarium specimen records, running them
through VoucherVision (https://github.com/Gene-Weaver/VoucherVision), and generating IUCN Red List assessment summaries with
Gemini.

## Requirements

- [Node.js](https://nodejs.org/) 18 or later (includes npm)
- Gemini API key
- VoucherVision auth token — only if you switch the VoucherVision backend to
  the remote VoucherVisionGO server (see below)

No Python is required; `pipeline.py` / `voucher_pipeline.py` are the disabled
legacy scripts.

## Setup

```bash
# 1. Clone the repo
git clone https://github.com/nybgvh/IRIS-Electron-Main.git
cd iucn-browser

# 2. Install Node dependencies
npm install

# 3. Run the app
npm start
```

On first launch, open **Settings** in the app and add:
- **Output Root Folder** — where species folders live
- **Gemini API Key** — used for the Red List summary step and, by default, for
  the VoucherVision voucher step
- **VoucherVision Auth Token** — only needed for the remote backend

## VoucherVision backends

The voucher step (OCR + label parsing for every image in `<species>/pics/`) has
two interchangeable backends, chosen under **Settings → VoucherVision options →
Backend**:

- **Local emulator** (default) — [vouchervision-emulator/](vouchervision-emulator/)
  makes two Gemini calls per image (OCR, then parsing) using the verbatim
  VoucherVision prompts and your Gemini API key. Produces the same
  `<stem>.json` shape as the server. Smoke-test it on one image with
  `npm run smoke:vv -- path/to/image.jpg`.
- **VoucherVisionGO server** — posts the image to the remote `/process`
  endpoint with the auth token.

Both default to `gemini-3.1-flash-lite` and the `SLTPvM_full.yaml` prompt.

All credentials are stored locally in Electron's per-user app-data directory
(never committed to the repo).

