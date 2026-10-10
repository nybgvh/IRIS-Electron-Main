# IRIS  Integrated Red List Inference from Specimens

A desktop application for generating IUCN Red List assessment criteria (Taxonomy, Geographic Range, Habitat, Ecology, Use & Trade, Threats & Conservation) from herbarium specimen using VoucherVision.

## Overview

IRIS streamlines the Red List assessment workflow:

1. **Upload** herbarium specimen images for a species
2. **Transcribe** label data automatically using VoucherVision (see https://github.com/Gene-Weaver/VoucherVision)
3. **Summarise** specimen records into a structured IUCN Red List draft assessment
4. **Browse** assessments by section with an interactive map of collection localities

## Features

- Multi-user login with per-user species data
- AI-powered label transcription directly from herbarium sheet images
- Structured draft assessments across all 6 IUCN Red List sections
- Assessments in 10 languages (English, Spanish, French, Arabic, Portuguese, German, Italian, Chinese, Dutch, Russian)
- Interactive specimen map with collection date colour coding and GPS confidence indicators
- Source image thumbnails with zoomable lightbox viewer
- SQLite database for fast local storage

## Requirements

- [Node.js](https://nodejs.org/) 18 or later (includes npm)
- Gemini API key
- VoucherVision auth token — only if you switch the VoucherVision backend to
  the remote VoucherVisionGO server (see below)

No Python is required; `pipeline.py` / `voucher_pipeline.py` are the disabled
legacy scripts.

## Installation

```bash
git clone https://github.com/nybgvh/IRIS-Electron-Main.git
cd IRIS-Electron-Main
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

1. Launch the app and register an account
2. Click the ⚙ gear icon → Settings and enter:
   - **Output root folder**  where species data will be stored (e.g. `C:\Users\you\Documents\IRIS\output`)
   - **Gemini API key**  get one at [aistudio.google.com](https://aistudio.google.com)
3. Click Save


### Adding a new species
1. Click **+ New species** in the sidebar
2. Enter the species name and select herbarium images
3. Click **Create & process**
4. When complete, click **Summarize now** and select a language
5. The draft assessment appears with an interactive map

### Browsing assessments
- Click any species in the sidebar to view its assessment
- Click map markers to see specimen details
- Click thumbnails to open the full image

## Data Storage

All data is stored locally on your machine:
- **Database:** `%AppData%\iris-iucn\redlist.db` (Windows) or `~/Library/Application Support/iris-iucn/redlist.db` (Mac)
- **Settings:** stored alongside the database in `settings.json`
- **Species data:** in your configured output root folder

