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

- [Node.js LTS](https://nodejs.org/) (v18 or higher)
- A [Gemini API key](https://aistudio.google.com/) 

## Installation

```bash
git clone https://github.com/nybgvh/IRIS-Electron-Main.git
cd IRIS-Electron-Main
npm install
npm start
```

No Python is needed — everything runs in Node/Electron. Textbook OCR (Tesseract) is built in and works offline for English.

## First-time Setup

1. Launch the app and register an account
2. Click the ⚙ gear icon → Settings and enter:
   - **Output root folder**  where species data will be stored (e.g. `C:\Users\you\Documents\IRIS\output`)
   - **Gemini API key**  get one at [aistudio.google.com](https://aistudio.google.com)
3. Click Save


### GBIF tab

Click **GBIF** in the sidebar to browse gbif.org inside the app. Search and filter as usual, then either open a specimen and press **Add this specimen**, or press **Add from this search** (set how many, up to 500; press again for more). Selected specimens appear in the tray at the bottom; click × to remove one. Press **Create project…**, enter the species name (a name that already exists is not allowed), and IRIS downloads the images into a new project that appears in the species list. Label transcription with Gemini then starts automatically. If it fails, the downloaded images are kept, and you can retry from the species page with *Transcribe labels (Gemini)*.

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

