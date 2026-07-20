# IRIS — IUCN Red List Information System

An Electron desktop app for browsing herbarium specimen records, running them
through VoucherVision, and generating IUCN Red List assessment summaries with
Gemini.

Runs on Windows, macOS, and Linux.

## Requirements

- [Node.js](https://nodejs.org/) 18 or later (includes npm)
- [Python](https://www.python.org/downloads/) 3.9 or later, available on your
  `PATH` as `python3`, `python`, or (on Windows) the `py` launcher — the app
  auto-detects whichever is present
- A Gemini API key ([Google AI Studio](https://aistudio.google.com/apikey))
- A VoucherVision auth token

## Setup

```bash
# 1. Clone the repo
git clone <this-repo-url>
cd iucn-browser

# 2. Install Node dependencies
npm install

# 3. Install Python dependencies
pip install -r requirements.txt
# on macOS/Linux, use pip3 if `pip` isn't mapped to Python 3:
pip3 install -r requirements.txt

# 4. Run the app
npm start
```

On first launch, open **Settings** in the app and add:
- **Output Root Folder** — where species folders live
- **Gemini API Key** — used for both the Red List summary step and the
  VoucherVision voucher step
- **VoucherVision Auth Token** — used for the voucher step

All credentials are stored locally in Electron's per-user app-data directory
(never committed to the repo).

## Platform notes

- **Windows**: the app looks for `python`, then `py`, then `python3` on
  `PATH`. Make sure "Add python.exe to PATH" was checked during install.
- **macOS / Linux**: the app looks for `python3` first, then `python`.
- Line endings, file paths, and the settings/database storage location are
  all handled through Node/Electron APIs (`path.join`, `app.getPath`), so no
  manual path adjustments are needed between OSes.

## Project structure

| File                  | Purpose                                              |
|------------------------|------------------------------------------------------|
| `main.js`              | Electron main process, IPC handlers, pipeline spawn  |
| `preload.js`           | Context-isolated bridge exposed to the renderer       |
| `renderer.js`          | UI logic                                              |
| `index.html` / `style.css` | UI markup and styling                            |
| `database.js`          | Local SQLite (via sql.js) persistence                |
| `pipeline.py`          | Generates Red List summaries via Gemini              |
| `voucher_pipeline.py`  | Runs images through VoucherVision                     |
