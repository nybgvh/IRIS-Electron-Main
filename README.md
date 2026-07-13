# IRIS — IUCN Red List Information System

A desktop application for generating IUCN Red List assessments from herbarium specimen images using AI-powered transcription and summarisation.

## Overview

IRIS streamlines the Red List assessment workflow:

1. **Upload** herbarium specimen images for a species
2. **Transcribe** label data using VoucherVision (https://github.com/Gene-Weaver/VoucherVision)
3. **Summarise** specimen records into a structured IUCN Red List assessment
4. **Browse** assessments by section with an interactive map of collection localities

## Features

- Multi-user login with per-user species data
- VoucherVision integration for automated label transcription
- AI-generated assessments across 6 IUCN sections (Taxonomy, Geographic Range, Habitat, Ecology, Use & Trade, Threats)
- Assessment output in multiple languages
- Interactive specimen map with collection date colour coding and GPS confidence indicators

## Requirements

- [Node.js](https://nodejs.org/) (v18 or higher)
- [Python 3](https://www.python.org/) with the following packages:
```bash
  pip install google-generativeai VoucherVision
```

## Installation

```bash
git clone https://github.com/nybgvh/IRIS-Electron-Main.git
cd IRIS-Electron-Main
npm install
npm start
```

## First-time Setup

1. Launch the app and register an account
2. Open **Settings** and enter:
   - Output root folder (where species data will be stored)
   - Gemini API key
   - VoucherVision auth token
   - Vertex AI project ID


## Usage

### Adding a new species
1. Click **+ New species** in the sidebar
2. Enter the species name and select herbarium images
3. Click **Create & process** — VoucherVision will transcribe the labels
4. Click **Summarise** to generate the Red List assessment

### Browsing assessments
- Click any species in the sidebar to view its assessment
- Use the section nav pills to jump between sections
- Click map markers to see specimen details
- Click thumbnails to view source images full size
