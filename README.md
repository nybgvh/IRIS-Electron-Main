# IRIS  Integrated Red List Inference from Specimens

A desktop application for generating IUCN Red List assessment criteria (Taxonomy, Geographic Range, Habitat, Ecology, Use & Trade, Threats & Conservation) from herbarium specimens using VoucherVision.

## Overview

IRIS streamlines the Red List assessment workflow:

1. **Upload** herbarium specimen images for a species, or import them from GBIF
2. **Transcribe** label data automatically using VoucherVision (see https://github.com/Gene-Weaver/VoucherVision)
3. **Summarize** specimen records into a structured IUCN Red List draft assessment
4. **Browse** assessments by section with an interactive map of collection localities

## Features

- Multi-user login with per-user species data
- AI-powered label transcription directly from herbarium sheet images (JPEG, PNG, WebP, TIFF, BMP, HEIC/HEIF, JPEG 2000)
- Structured draft assessments across all 6 IUCN Red List sections
- Assessments in 10 languages (English, Spanish, French, Arabic, Portuguese, German, Italian, Chinese, Dutch, Russian)
- Interactive specimen map with collection date color coding and GPS confidence indicators
- Source image thumbnails with zoomable lightbox viewer
- GBIF tab for browsing gbif.org, bookmarking searches and importing specimen images, with a References tab listing every imported source
- Light and dark themes
- SQLite database for fast local storage

## Requirements

- [Node.js LTS](https://nodejs.org/) (v18 or higher)
- A [Gemini API key](https://aistudio.google.com/)

No Python is required. Transcription and summaries call Gemini directly from the app.

## Installation

```bash
git clone https://github.com/nybgvh/IRIS-Electron-Main.git
cd IRIS-Electron-Main
npm install
npm start
```

## First-time Setup

1. Launch the app and register an account
2. Click the ⚙ gear icon → Settings and enter:
   - **Output root folder**  where species data will be stored (e.g. `C:\Users\you\Documents\IRIS\output`)
   - **Gemini API key**  get one at [aistudio.google.com](https://aistudio.google.com)
3. Click Save

`gemini-3.1-pro-preview` requires billing to be enabled on the Google account that owns the key.

### Adding a new species
1. Click **+ New species** in the sidebar
2. Enter the species name and select herbarium images
3. Click **Create & process**
4. When complete, click **Summarize now** and select a language
5. The draft assessment appears with an interactive map

TIFF, BMP, HEIC/HEIF and JPEG 2000 images get a `.jpg` copy in the species' `pics/` folder (the original is kept), and that copy is what gets transcribed and shown as a thumbnail. Re-running transcription skips images that already have a result.

### Importing from GBIF
1. Open the **GBIF** tab and browse or search gbif.org
2. Use **Import…** to pull the specimen images from the current search, or **Add to Library** on an occurrence page
3. Bookmark searches you want to come back to
4. Imported sources are listed in the **References** tab

### Browsing assessments
- Click any species in the sidebar to view its assessment
- Click map markers to see specimen details
- Click thumbnails to open the full image

## Advanced settings

Settings → **Advanced** (collapsed by default) holds the transcription options (models, thinking levels, prompt, concurrency, timeout, retries) and the Red List model and timeout. Both steps default to `gemini-3.1-pro-preview`.

Transcription runs VoucherVision's OCR and parsing prompts directly against Gemini; see [vouchervision-emulator/](vouchervision-emulator/). Smoke-test it on one image with:

```bash
npm run smoke:vv -- path/to/image.jpg
```

A few options are only in `settings.json`: the `vouchervision.backend` switch (`"remote"` sends images to the hosted VoucherVisionGO server and needs an `authToken`), the API base URLs, and OCR-only / notebook modes.

## Building installers

```bash
npm run dist:mac   # .dmg (x64 + arm64)
npm run dist:win   # NSIS installer (x64)
```

Icons are read from `assets/icon.icns` and `assets/icon.ico`.

## Data Storage

All data is stored locally on your machine:
- **Database:** `%AppData%\iris-iucn\redlist.db` (Windows) or `~/Library/Application Support/iris-iucn/redlist.db` (Mac)
- **Settings:** stored alongside the database in `settings.json`
- **Species data:** in your configured output root folder. Each species folder holds its images (`pics/`), one `.json` per transcribed image, and the summary as `red_list_summary_rd.json` plus a plain-text `red_list_summary_rd.txt`.
