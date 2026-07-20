# IRIS — IUCN Red List Information System

An Electron desktop app for browsing herbarium specimen records, running them
through VoucherVision (https://github.com/Gene-Weaver/VoucherVision), and generating IUCN Red List assessment summaries with
Gemini.

## Requirements

- [Node.js](https://nodejs.org/) 18 or later (includes npm)
- [Python](https://www.python.org/downloads/) 3.9 or later, available on your
  `PATH` as `python3`, `python`, or (on Windows) the `py` launcher — the app
  auto-detects whichever is present
- Gemini API key 
- VoucherVision auth token

## Setup

```bash
# 1. Clone the repo
git clone https://github.com/nybgvh/IRIS-Electron-Main.git
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

