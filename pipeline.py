"""
IRIS Red List Pipeline
Spawned by the Electron app. Streams progress via stdout as JSON lines.
Usage: python pipeline.py <output_root> <gemini_api_key> [species_name]
"""

import sys
import json
import re
from pathlib import Path
from datetime import datetime

# ── Stdout helpers ────────────────────────────────────────────────────────────
def emit(event: str, **kwargs):
    print(json.dumps({"event": event, **kwargs}), flush=True)

def emit_progress(species, status, message=""):
    emit("progress", species=species, status=status, message=message)

def emit_done(species):
    emit("done", species=species)

def emit_error(species, message):
    emit("error", species=species, message=message)

def emit_finish(total, succeeded, failed):
    emit("finish", total=total, succeeded=succeeded, failed=failed)

# ── Dependency check ──────────────────────────────────────────────────────────
try:
    import google.generativeai as genai
except ImportError:
    emit("fatal", message="google-generativeai not installed. Run: pip install google-generativeai")
    sys.exit(1)

# ── Args ──────────────────────────────────────────────────────────────────────
if len(sys.argv) < 3:
    emit("fatal", message="Usage: pipeline.py <output_root> <api_key> [species_name] [language]")
    sys.exit(1)

output_root  = Path(sys.argv[1])
api_key      = sys.argv[2]
only_species = sys.argv[3] if len(sys.argv) > 3 else None
language     = sys.argv[4] if len(sys.argv) > 4 else "English"

if not output_root.is_dir():
    emit("fatal", message=f"Output root not found: {output_root}")
    sys.exit(1)

genai.configure(api_key=api_key)
model = genai.GenerativeModel("gemini-3.1-pro-preview")

SECTION_KEYS = ["taxonomy", "geographic_range", "habitat", "ecology", "use_and_trade", "threats"]

# ── Prompt ────────────────────────────────────────────────────────────────────
PROMPT_TEMPLATE = """
You are extracting Red List assessment information from herbarium specimen OCR records.

LANGUAGE REQUIREMENT — CRITICAL:
Write the entire output in {language}. All section text, narratives, labels, and any stated
unavailability must be in {language}. Do not mix languages.

Use only information present in the records. Do not invent information.

CRITICAL CITATION RULE:
Every specimen filename must be cited individually, each preceded by its own "source_image:" prefix.
CORRECT:  source_image: abc123, source_image: def456
WRONG:    source_image: abc123, def456

FORMATTING RULES (applied within each section value):
1. Sub-criteria use a bullet line with a bold label, formatted exactly as:
*   **Label**
Narrative text follows on the next line(s) as plain text.
2. Bold (**text**) ONLY for sub-criterion labels.
3. Italic (*text*) ONLY for scientific names.
4. No markdown headers (##), horizontal rules (---), or extra symbols.

CORRECT example for one section value:
"*   **Accepted scientific name**\\nThe accepted name is *Carissa spinarum* L. (source_image: abc123, source_image: def456).\\n\\n*   **Taxonomic notes**\\nNo information available from specimen records."

OUTPUT FORMAT — CRITICAL:
You MUST respond with ONLY a valid JSON object. No prose before or after. No markdown fences.
The JSON must have exactly these six keys:
  "taxonomy", "geographic_range", "habitat", "ecology", "use_and_trade", "threats"

Each value is a plain string containing the formatted assessment text for that section.

If information is not available for a section, use:
"No information available from specimen records."

SECTION REQUIREMENTS:

taxonomy:
* Accepted scientific name
* Identification history and taxonomic notes
* Any uncertainty in identification

geographic_range:
* Countries, states, provinces, localities
* Distribution patterns, elevation range, geographic concentrations
* GPS coordinates: for each specimen with decimalLatitude/decimalLongitude, report coordinates
  and note whether inferredGPSConfidence is "verbatim" or inferred

habitat:
* Habitat descriptions, substrate, vegetation, moisture conditions
* Habitat patterns and unusual habitats
* IUCN Habitat Classification Scheme categories

ecology:
* Growth form, life history, phenology (flowering/fruiting/sterile)
* Associated vegetation, ecological observations
* Elevational and substrate preferences

use_and_trade:
* Medicinal, food, ornamental, timber, fiber, cultural use
* Cultivation, harvesting, trade
* Only report uses explicitly mentioned

threats:
* Habitat destruction, agriculture, grazing, logging, urbanization, fire, invasive species
* Protected areas, reserves, ex situ collections
* IUCN Threat scheme classification

Records:
{records}
"""

# ── Parse Gemini JSON response ────────────────────────────────────────────────
def parse_response(text: str) -> dict:
    text = text.strip()
    # Strip markdown fences
    text = re.sub(r'^```(?:json)?\s*', '', text, flags=re.IGNORECASE)
    text = re.sub(r'\s*```\s*$', '', text)
    text = text.strip()
    # Find first { and last }
    start = text.find('{')
    end   = text.rfind('}')
    if start != -1 and end != -1:
        text = text[start:end + 1]
    parsed = json.loads(text)
    for key in SECTION_KEYS:
        if key not in parsed:
            parsed[key] = "No information available from specimen records."
    return parsed

# ── Process one species ───────────────────────────────────────────────────────
def process_species(json_dir: Path) -> bool:
    species    = json_dir.name
    json_files = list(json_dir.glob("*.json"))
    json_files = [f for f in json_files if f.name != "red_list_summary_rd.json"]

    if not json_files:
        emit_progress(species, "skip", "No JSON specimen files found")
        return False

    emit_progress(species, "start", f"Reading {len(json_files)} specimen records…")

    records = []
    for json_file in json_files:
        try:
            with open(json_file, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            emit_progress(species, "warn", f"Could not read {json_file.name}: {e}")
            continue

        fmt = data.get("formatted_json", {})
        records.append({
            "filename":                 json_file.name,
            "source_image":             json_file.stem,
            "scientificName":           fmt.get("scientificName"),
            "country":                  fmt.get("country"),
            "stateProvince":            fmt.get("stateProvince"),
            "locality":                 fmt.get("locality"),
            "decimalLatitude":          fmt.get("decimalLatitude"),
            "decimalLongitude":         fmt.get("decimalLongitude"),
            "inferredGPSConfidence":    fmt.get("inferredGPSConfidence"),
            "habitat":                  fmt.get("habitat"),
            "specimenDescription":      fmt.get("specimenDescription"),
            "minimumElevationInMeters": fmt.get("minimumElevationInMeters"),
            "maximumElevationInMeters": fmt.get("maximumElevationInMeters"),
            "collectionDate":           fmt.get("collectionDate"),
            "additionalText":           fmt.get("additionalText"),
            "ocr_text":                 data.get("ocr"),
        })

    if not records:
        emit_error(species, "All JSON files failed to parse")
        return False

    emit_progress(species, "generating", f"Sending {len(records)} records to Gemini…")

    prompt = PROMPT_TEMPLATE.format(records=json.dumps(records, indent=2), language=language)

    try:
        response = model.generate_content(
            prompt,
            request_options={"timeout": 300},
        )
        response_text = response.text
    except Exception as e:
        emit_error(species, f"Gemini API error: {e}")
        return False

    # Parse JSON response
    try:
        sections = parse_response(response_text)
    except Exception as e:
        emit_error(species, f"JSON parse failed: {e}. Check _debug_response.txt in species folder.")
        # Save raw response for inspection
        try:
            with open(json_dir / "_debug_response.txt", "w", encoding="utf-8") as f:
                f.write(response_text)
        except Exception:
            pass
        return False

    output = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "model":        "gemini-3.1-pro-preview",
        "language":     language,
        "species":      species,
        "sections":     sections,
    }

    # Write JSON output
    json_out = json_dir / "red_list_summary_rd.json"
    try:
        with open(json_out, "w", encoding="utf-8") as f:
            json.dump(output, f, indent=2, ensure_ascii=False)
    except Exception as e:
        emit_error(species, f"Could not write JSON output: {e}")
        return False

    emit_done(species)
    return True

# ── Main ──────────────────────────────────────────────────────────────────────
if only_species:
    target = output_root / only_species
    if not target.is_dir():
        emit("fatal", message=f"Species folder not found: {target}")
        sys.exit(1)
    dirs = [target]
else:
    dirs = sorted([d for d in output_root.iterdir() if d.is_dir()])

emit("start", total=len(dirs))
succeeded = 0
failed    = 0

for d in dirs:
    ok = process_species(d)
    if ok: succeeded += 1
    else:  failed    += 1

emit_finish(total=len(dirs), succeeded=succeeded, failed=failed)
