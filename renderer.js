// ── Auth ──────────────────────────────────────────────────
const authScreen   = document.getElementById("auth-screen");
const authError    = document.getElementById("auth-error");
const authTabs     = document.querySelectorAll(".auth-tab");
const tabLogin     = document.getElementById("tab-login");
const tabRegister  = document.getElementById("tab-register");

function showAuthError(msg) {
  authError.textContent = msg;
  authError.classList.remove("hidden");
}
function clearAuthError() { authError.classList.add("hidden"); }

authTabs.forEach(tab => {
  tab.addEventListener("click", () => {
    authTabs.forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    clearAuthError();
    if (tab.dataset.tab === "login") {
      tabLogin.classList.remove("hidden");
      tabRegister.classList.add("hidden");
    } else {
      tabLogin.classList.add("hidden");
      tabRegister.classList.remove("hidden");
    }
  });
});

document.getElementById("login-btn").addEventListener("click", async () => {
  clearAuthError();
  const u = document.getElementById("login-username").value.trim();
  const p = document.getElementById("login-password").value;
  const result = await window.api.login(u, p);
  if (result.error) { showAuthError(result.error); return; }
  onLoggedIn(result.user);
});

["login-username", "login-password"].forEach(id => {
  document.getElementById(id).addEventListener("keydown", e => {
    if (e.key === "Enter") document.getElementById("login-btn").click();
  });
});

document.getElementById("register-btn").addEventListener("click", async () => {
  clearAuthError();
  const u  = document.getElementById("reg-username").value.trim();
  const p  = document.getElementById("reg-password").value;
  const p2 = document.getElementById("reg-confirm").value;
  if (p !== p2) { showAuthError("Passwords do not match."); return; }
  const result = await window.api.register(u, p);
  if (result.error) { showAuthError(result.error); return; }
  onLoggedIn(result.user);
});

["reg-username", "reg-password", "reg-confirm"].forEach(id => {
  document.getElementById(id).addEventListener("keydown", e => {
    if (e.key === "Enter") document.getElementById("register-btn").click();
  });
});

function onLoggedIn(user) {
  authScreen.classList.add("hidden");
  document.getElementById("user-badge").textContent = user.username;
  autoLoadLastFolder();
}

async function autoLoadLastFolder() {
  // Try to load from the configured output root first
  const outputRoot = await window.api.getOutputRoot();
  if (outputRoot) {
    await loadFromOutputRoot();
    return;
  }
  // Fall back to last folder from DB
  const result = await window.api.getLastFolder();
  if (!result || !result.lastFolder) return;
  if (result.allFolders && result.allFolders.length > 1) {
    showFolderPicker(result.allFolders);
    return;
  }
  await loadFolderFromDb(result.lastFolder);
}

async function loadFolderFromDb(rootDir) {
  const result = await window.api.loadFolderFromDb(rootDir);
  if (!result || result.error || !result.species) return;

  state.rootDir  = result.rootDir;
  state.species  = result.species;
  state.filtered = result.species;
  state.active   = null;

  els.searchInput.disabled = false;
  els.searchInput.value    = "";

  renderSpeciesList();
  showWelcome();
  updateStats();
  runAllBtn.disabled = state.species.length === 0;
}

function showFolderPicker(folders) {
  // Update welcome panel to show folder choices
  const welcome = document.getElementById("welcome");
  welcome.classList.remove("hidden");
  document.getElementById("viewer").classList.add("hidden");

  welcome.innerHTML = `
    <div class="welcome-icon">◈</div>
    <h1>Welcome back</h1>
    <p>Select a previously opened folder or open a new one.</p>
    <div id="folder-list">
      ${folders.map(f => `
        <button class="folder-choice-btn" data-dir="${f.root_dir}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
          <span>${f.root_dir}</span>
          <small>${new Date(f.last_used).toLocaleDateString()}</small>
        </button>
      `).join("")}
    </div>
    <button class="cta-btn" id="welcome-open-btn" style="margin-top:8px">Open new folder</button>
  `;

  welcome.querySelectorAll(".folder-choice-btn").forEach(btn => {
    btn.addEventListener("click", () => loadFolderFromDb(btn.dataset.dir));
  });
  document.getElementById("welcome-open-btn").addEventListener("click", openFolder);
}

document.getElementById("logout-btn").addEventListener("click", async () => {
  await window.api.logout();
  state.rootDir = null; state.species = []; state.filtered = [];
  state.active = null; state.summaryText = null;
  state.picsMap = {}; state.specimens = [];
  els.searchInput.disabled = true;
  els.searchInput.value    = "";
  runAllBtn.disabled       = true;
  renderSpeciesList();
  updateStats();
  showWelcome();
  authScreen.classList.remove("hidden");
  document.getElementById("login-username").value = "";
  document.getElementById("login-password").value = "";
  clearAuthError();
  authTabs[0].click();
});

window.api.currentUser().then(user => { if (user) onLoggedIn(user); });

// ── State ────────────────────────────────────────────────
let state = {
  rootDir: null,
  species: [],
  filtered: [],
  active: null,
  summaryText: null,
  summaryData: null,
  picsMap: {},
  specimens: [],
};

// Section accent colours (cycling)
const SECTION_COLORS = [
  "#6db86d", "#68b4b0", "#c4a84a",
  "#b06868", "#8068b0", "#b08068",
];

// ── Element refs ─────────────────────────────────────────
const $ = (id) => document.getElementById(id);

const els = {
  openFolderBtn:  $("open-folder-btn"),
  welcomeOpenBtn: $("welcome-open-btn"),
  searchInput:    $("search-input"),
  speciesList:    $("species-list"),
  speciesStats:   $("species-stats"),
  statsCount:     $("stats-count"),
  statsAssessed:  $("stats-assessed"),
  emptyState:     $("empty-state"),
  welcome:        $("welcome"),
  viewer:         $("viewer"),
  speciesTitle:   $("species-title"),
  speciesMeta:    $("species-meta"),
  sectionNav:     $("section-nav"),
  summaryBody:    $("summary-body"),
};

// ── Folder management ────────────────────────────────────
const reloadBtn     = document.getElementById("reload-btn");
const langModal      = document.getElementById("lang-modal");
const langBackdrop   = document.getElementById("lang-backdrop");
const langClose      = document.getElementById("lang-close");
const langGrid       = document.getElementById("lang-grid");
const langConfirmBtn = document.getElementById("lang-confirm-btn");

// ── Language picker setup ─────────────────────────────────
const LANGUAGES = [
  { code: "en", label: "English",    flag: "🇬🇧" },
  { code: "es", label: "Spanish",    flag: "🇪🇸" },
  { code: "fr", label: "French",     flag: "🇫🇷" },
  { code: "ar", label: "Arabic",     flag: "🇸🇦" },
  { code: "pt", label: "Portuguese", flag: "🇵🇹" },
  { code: "de", label: "German",     flag: "🇩🇪" },
  { code: "it", label: "Italian",    flag: "🇮🇹" },
  { code: "zh", label: "Chinese",    flag: "🇨🇳" },
  { code: "nl", label: "Dutch",      flag: "🇳🇱" },
  { code: "ru", label: "Russian",    flag: "🇷🇺" },
];

let selectedLang   = "English";
let pendingSpecies = null;

LANGUAGES.forEach(lang => {
  const btn = document.createElement("button");
  btn.className = "lang-btn" + (lang.label === "English" ? " selected" : "");
  btn.dataset.lang = lang.label;
  btn.innerHTML = `<span class="lang-flag">${lang.flag}</span>${lang.label}`;
  btn.addEventListener("click", () => {
    langGrid.querySelectorAll(".lang-btn").forEach(b => b.classList.remove("selected"));
    btn.classList.add("selected");
    selectedLang = lang.label;
  });
  langGrid.appendChild(btn);
});

function openLangPicker(speciesName) {
  pendingSpecies = speciesName;
  langModal.classList.remove("hidden");
}

function closeLangPicker() {
  langModal.classList.add("hidden");
}

langBackdrop.addEventListener("click", closeLangPicker);
langClose.addEventListener("click", closeLangPicker);
langConfirmBtn.addEventListener("click", () => {
  closeLangPicker();
  runPipeline(pendingSpecies, selectedLang);
});
const newSpeciesBtn = document.getElementById("new-species-btn");
const runAllBtn     = document.getElementById("run-all-btn");
const generateBtn   = document.getElementById("generate-btn");

async function openFolder() {
  await loadFromOutputRoot();
}

async function loadFromOutputRoot() {
  const result = await window.api.loadOutputRoot();
  if (!result || result.error) {
    if (result && result.error) alert(result.error);
    return;
  }
  applyFolderResult(result);
}

function applyFolderResult(result) {
  state.rootDir     = result.rootDir;
  state.species     = result.species;
  state.filtered    = result.species;
  state.active      = null;
  state.summaryText = null;

  els.searchInput.disabled = false;
  els.searchInput.value    = "";

  renderSpeciesList();
  showWelcome();
  updateStats();
  runAllBtn.disabled    = state.species.length === 0;
  reloadBtn.disabled    = false;
  newSpeciesBtn.disabled= false;
}

reloadBtn.addEventListener("click", loadFromOutputRoot);

// ── Search / filter ──────────────────────────────────────
els.searchInput.addEventListener("input", () => {
  const q = els.searchInput.value.toLowerCase().trim();
  state.filtered = q
    ? state.species.filter((s) => s.name.toLowerCase().includes(q))
    : state.species;
  renderSpeciesList();
});

// ── Render species list ──────────────────────────────────
function renderSpeciesList() {
  // Remove all items except empty-state placeholder
  const items = els.speciesList.querySelectorAll(".species-item");
  items.forEach((el) => el.remove());

  if (state.filtered.length === 0) {
    els.emptyState.classList.remove("hidden");
    els.emptyState.querySelector("p").textContent =
      state.species.length === 0
        ? "Open your IRIS output folder to browse species summaries."
        : "No species match your search.";
    return;
  }

  els.emptyState.classList.add("hidden");

  state.filtered.forEach((sp) => {
    const li = document.createElement("li");
    li.className = "species-item" + (state.active === sp.name ? " active" : "");
    li.dataset.name = sp.name;

    const dot = document.createElement("div");
    dot.className = "species-dot" + (sp.hasSummary ? " has-summary" : "");

    const nameBlock = document.createElement("div");
    nameBlock.className = "species-name-block";

    const nameLine = document.createElement("div");
    nameLine.className = "species-name";
    nameLine.textContent = sp.displayName;

    const countLine = document.createElement("div");
    countLine.className = "species-count";
    countLine.textContent = sp.specimenCount
      ? `${sp.specimenCount} specimen${sp.specimenCount !== 1 ? "s" : ""}`
      : "no specimens indexed";

    nameBlock.appendChild(nameLine);
    nameBlock.appendChild(countLine);

    li.appendChild(dot);
    li.appendChild(nameBlock);

    if (!sp.hasSummary) {
      const tag = document.createElement("span");
      tag.className = "no-summary-tag";
      tag.textContent = "No summary";
      li.appendChild(tag);
    }

    // Delete button
    const delBtn = document.createElement("button");
    delBtn.className = "species-delete-btn";
    delBtn.title = "Delete species";
    delBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openDeleteModal(sp);
    });
    li.appendChild(delBtn);

    li.addEventListener("click", () => selectSpecies(sp));
    els.speciesList.appendChild(li);
  });
}

// ── Update stats bar ─────────────────────────────────────
function updateStats() {
  const total = state.species.length;
  const assessed = state.species.filter((s) => s.hasSummary).length;

  els.speciesStats.classList.toggle("hidden", total === 0);
  els.statsCount.textContent = `${total} species`;
  els.statsAssessed.textContent = `${assessed} assessed`;
}

// ── Select a species ─────────────────────────────────────
async function selectSpecies(sp) {
  state.active = sp.name;

  // Update list highlight
  els.speciesList.querySelectorAll(".species-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.name === sp.name);
  });

  // Show viewer
  els.welcome.classList.add("hidden");
  els.viewer.classList.remove("hidden");

  els.speciesTitle.textContent = sp.displayName;
  els.speciesMeta.textContent = sp.specimenCount
    ? `${sp.specimenCount} specimen records · ${sp.hasSummary ? "Assessment summary available" : "No summary generated yet"}`
    : sp.hasSummary
    ? "Assessment summary available"
    : "No summary generated yet";

  // Clear previous content
  els.sectionNav.innerHTML = "";
  els.summaryBody.innerHTML = "";

  if (!sp.hasSummary) {
    // Still load specimens for the map
    const specimens = await window.api.readSpecimens(state.rootDir, sp.name).catch(() => []);
    renderMap(specimens);
    els.summaryBody.innerHTML = `
      <div class="no-summary-msg">
        <div class="icon">📄</div>
        <p>No <code>red_list_summary_rd.json</code> found for <em>${sp.displayName}</em>.</p>
        <p style="font-size:12px; margin-top:6px;">Run the assessment pipeline to generate a summary.</p>
      </div>`;
    return;
  }

  // Show loading
  els.summaryBody.innerHTML = `<div class="loading-state"><div class="spinner"></div> Loading summary…</div>`;

  let summary;
  try {
    [summary, state.picsMap, state.specimens] = await Promise.all([
      window.api.readSummary(state.rootDir, sp.name),
      window.api.resolvePics(state.rootDir, sp.name),
      window.api.readSpecimens(state.rootDir, sp.name),
    ]);
  } catch (err) {
    els.summaryBody.innerHTML = `<div class="no-summary-msg"><div class="icon">⚠️</div><p>IPC error: ${err.message}</p></div>`;
    return;
  }

  if (summary && summary.error) {
    els.summaryBody.innerHTML = `<div class="no-summary-msg"><div class="icon">⚠️</div><p>Could not read file: ${summary.error}</p></div>`;
    return;
  }

  if (!summary) {
    els.summaryBody.innerHTML = `<div class="no-summary-msg"><div class="icon">⚠️</div><p>Could not read summary file.</p></div>`;
    return;
  }

  state.summaryData = summary;
  // Build plain text for copy button
  state.summaryText = summary._legacy ? summary.raw
    : Object.entries(summary.sections || {})
        .map(([k, v]) => `${k.replace(/_/g, " ").toUpperCase()}\n\n${v}`)
        .join("\n\n---\n\n");

  renderMap(state.specimens);
  renderSummary(summary);
}

// ── Map ───────────────────────────────────────────────────
let leafletMap = null;

// Colour palette for collection decades — from cool (old) to warm (recent)
const DECADE_PALETTE = [
  { decade: null,  color: "#7a7a9a", label: "Unknown date" },
  { decade: 1800,  color: "#5a6fa8", label: "1800s" },
  { decade: 1900,  color: "#4a90b8", label: "1900–1909" },
  { decade: 1910,  color: "#3aada0", label: "1910–1919" },
  { decade: 1920,  color: "#3ab87a", label: "1920–1929" },
  { decade: 1930,  color: "#6abf50", label: "1930–1939" },
  { decade: 1940,  color: "#a8c040", label: "1940–1949" },
  { decade: 1950,  color: "#d4b830", label: "1950–1959" },
  { decade: 1960,  color: "#e09030", label: "1960–1969" },
  { decade: 1970,  color: "#e06830", label: "1970–1979" },
  { decade: 1980,  color: "#d84040", label: "1980–1989" },
  { decade: 1990,  color: "#c030a0", label: "1990–1999" },
  { decade: 2000,  color: "#9030c8", label: "2000–2009" },
  { decade: 2010,  color: "#6030e0", label: "2010–2019" },
  { decade: 2020,  color: "#3050f0", label: "2020–present" },
];

function getDecadeEntry(dateStr) {
  if (!dateStr) return DECADE_PALETTE[0];
  const match = dateStr.match(/\b(1[89]\d\d|20\d\d)\b/);
  if (!match) return DECADE_PALETTE[0];
  const year = parseInt(match[1]);
  if (year < 1900) return DECADE_PALETTE[1]; // 1800s bucket
  // Find best matching decade
  const decade = Math.floor(year / 10) * 10;
  return DECADE_PALETTE.find(d => d.decade === decade) || DECADE_PALETTE[0];
}

function renderMap(specimens) {
  const mapEl    = document.getElementById("species-map");
  const mapPanel = document.getElementById("map-panel");

  if (leafletMap) { leafletMap.remove(); leafletMap = null; }

  if (!specimens || specimens.length === 0) {
    mapPanel.style.display = "none";
    return;
  }

  mapPanel.style.display = "block";

  leafletMap = L.map(mapEl, { zoomControl: true, attributionControl: false });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 18 }).addTo(leafletMap);

  const bounds = [];
  const usedDecades = new Set();

  specimens.forEach((sp) => {
    const isVerbatim = sp.confidence === "verbatim";
    const radius     = isVerbatim ? 9 : 5;
    const decEntry   = getDecadeEntry(sp.collectionDate);
    const color      = decEntry.color;
    const border     = isVerbatim ? "#fff" : color;
    const weight     = isVerbatim ? 1.5 : 0.8;

    usedDecades.add(decEntry);

    const marker = L.circleMarker([sp.lat, sp.lng], {
      radius,
      fillColor:   color,
      color:       border,
      weight,
      opacity:     0.9,
      fillOpacity: isVerbatim ? 0.9 : 0.6,
    }).addTo(leafletMap);

    const popupLines = [
      `<strong>${sp.source_image}</strong>`,
      sp.locality       ? `📍 ${sp.locality}`        : null,
      sp.country        ? `🌍 ${sp.country}`          : null,
      sp.collectionDate ? `📅 ${sp.collectionDate}`   : null,
      `<em>GPS: ${sp.confidence} · ${isVerbatim ? "large dot" : "small dot"}</em>`,
    ].filter(Boolean).join("<br>");

    marker.bindPopup(popupLines, { maxWidth: 260 });
    bounds.push([sp.lat, sp.lng]);
  });

  if (bounds.length === 1) {
    leafletMap.setView(bounds[0], 8);
  } else {
    leafletMap.fitBounds(bounds, { padding: [24, 24] });
  }

  // Build dynamic legend
  buildMapLegend(usedDecades);
}

function buildMapLegend(usedDecades) {
  const legend = document.getElementById("map-legend");
  legend.innerHTML = "";

  // GPS size section
  const sizeSection = document.createElement("div");
  sizeSection.className = "legend-section";

  [
    { r: 9, label: "Verbatim GPS",  border: "#fff"  },
    { r: 5, label: "Inferred GPS",  border: "transparent" },
  ].forEach(({ r, label, border }) => {
    const item = document.createElement("span");
    item.className = "legend-item";
    item.innerHTML = `
      <svg width="${r*2+4}" height="${r*2+4}" viewBox="0 0 ${r*2+4} ${r*2+4}">
        <circle cx="${r+2}" cy="${r+2}" r="${r}" fill="#aaa" stroke="${border}" stroke-width="1.5"/>
      </svg>
      <span class="legend-label">${label}</span>`;
    sizeSection.appendChild(item);
  });
  legend.appendChild(sizeSection);

  // Divider
  const div = document.createElement("div");
  div.className = "legend-divider";
  legend.appendChild(div);

  // Date colour section — sorted by decade, only ones used
  const dateSection = document.createElement("div");
  dateSection.className = "legend-section legend-dates";

  const sorted = [...usedDecades].sort((a, b) => {
    if (a.decade === null) return -1;
    if (b.decade === null) return 1;
    return a.decade - b.decade;
  });

  sorted.forEach(({ color, label }) => {
    const item = document.createElement("span");
    item.className = "legend-item";
    item.innerHTML = `
      <span class="legend-dot-sq" style="background:${color}"></span>
      <span class="legend-label">${label}</span>`;
    dateSection.appendChild(item);
  });
  legend.appendChild(dateSection);
}


// ── Parse and render summary ─────────────────────────────
const SECTION_DEFS = [
  { key: "taxonomy",         number: "1", title: "Taxonomy" },
  { key: "geographic_range", number: "2", title: "Geographic Range" },
  { key: "habitat",          number: "3", title: "Habitat" },
  { key: "ecology",          number: "4", title: "Ecology" },
  { key: "use_and_trade",    number: "5", title: "Use and Trade" },
  { key: "threats",          number: "6", title: "Threats and Conservation Actions" },
];

function renderSummary(summary) {
  els.sectionNav.innerHTML  = "";
  els.summaryBody.innerHTML = "";

  // Legacy plain text fallback
  if (summary._legacy) {
    const sections = parseSections(summary.raw);
    if (sections.length === 0) {
      const pre = document.createElement("div");
      pre.className = "section-body raw-text";
      pre.textContent = summary.raw;
      els.summaryBody.appendChild(pre);
      return;
    }
    renderSectionBlocks(sections.map((s, i) => ({
      number: String(i + 1), title: s.title, content: s.content,
    })));
    setupScrollSpy(sections.length);
    return;
  }

  // Structured JSON summary
  const secs = summary.sections || {};

  // Show generated date in meta bar
  if (summary.generated_at) {
    const d = new Date(summary.generated_at).toLocaleDateString();
    const lang = summary.language ? ` · ${summary.language}` : "";
    const existing = els.speciesMeta.textContent;
    if (!existing.includes("Generated")) {
      els.speciesMeta.textContent = [existing, `Generated ${d}${lang}`].filter(Boolean).join(" · ");
    }
  }

  const blocks = SECTION_DEFS.map(def => ({
    number:  def.number,
    title:   def.title,
    content: secs[def.key] || "No information available from specimen records.",
  }));

  renderSectionBlocks(blocks);
  setupScrollSpy(blocks.length);
}

function renderSectionBlocks(blocks) {
  blocks.forEach((sec, i) => {
    const color = SECTION_COLORS[i % SECTION_COLORS.length];

    const pill = document.createElement("button");
    pill.className = "nav-pill";
    pill.dataset.section = i;
    const dot = document.createElement("span");
    dot.className = "nav-dot";
    dot.style.color = color;
    pill.appendChild(dot);
    pill.appendChild(document.createTextNode(sec.title));
    pill.addEventListener("click", () =>
      document.getElementById(`section-${i}`)?.scrollIntoView({ behavior: "smooth" })
    );
    els.sectionNav.appendChild(pill);

    const block = document.createElement("div");
    block.className = "section-block";
    block.id = `section-${i}`;

    const header = document.createElement("div");
    header.className = "section-header";
    const numBadge = document.createElement("div");
    numBadge.className = "section-number";
    numBadge.style.background = color;
    numBadge.textContent = sec.number;
    const titleEl = document.createElement("div");
    titleEl.className = "section-title";
    titleEl.style.color = color;
    titleEl.textContent = sec.title;
    header.appendChild(numBadge);
    header.appendChild(titleEl);

    const body = document.createElement("div");
    body.className = "section-body";
    body.innerHTML = formatSectionContent(sec.content);

    block.appendChild(header);
    block.appendChild(body);
    els.summaryBody.appendChild(block);
  });
}

// ── Parse numbered sections (legacy .txt fallback) ────────
function parseSections(text) {
  // Match lines like "1. Taxonomy" or "1. TAXONOMY"
  const sectionRegex = /^(\d+)\.\s+([A-Z][^\n]+)/gm;
  const matches = [];
  let m;
  while ((m = sectionRegex.exec(text)) !== null) {
    matches.push({ number: m[1], title: toTitleCase(m[2].trim()), index: m.index, matchLen: m[0].length });
  }

  if (matches.length === 0) return [];

  return matches.map((match, i) => {
    const start = match.index + match.matchLen;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const content = text.slice(start, end).trim();
    return { number: match.number, title: match.title, content };
  });
}

function toTitleCase(str) {
  return str
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Format section content into HTML ─────────────────────
function formatSectionContent(raw) {
  const paragraphs = [];
  let current = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (current.length) { paragraphs.push(current); current = []; }
    } else {
      current.push(trimmed);
    }
  }
  if (current.length) paragraphs.push(current);

  const out = [];

  for (const para of paragraphs) {
    const allBullets = para.every((l) => l.startsWith("* "));
    if (allBullets) {
      para.forEach((l) => out.push(`<div class="bullet-line">${formatInline(l.slice(2))}</div>`));
      continue;
    }

    if (para.length === 1 && para[0].startsWith("* ")) {
      out.push(`<div class="bullet-line">${formatInline(para[0].slice(2))}</div>`);
      continue;
    }

    if (/^[A-Z][A-Za-z ]+:/.test(para[0])) {
      const colonIdx = para[0].indexOf(":");
      const head = para[0].slice(0, colonIdx);
      const restText = para[0].slice(colonIdx + 1).trim();
      out.push(`<p><strong>${head}:</strong>${restText ? " " + formatInline(restText) : ""}</p>`);
      if (para.length > 1) {
        out.push(`<p>${para.slice(1).map(formatInline).join(" ")}</p>`);
      }
      continue;
    }

    out.push(`<p>${para.map(formatInline).join(" ")}</p>`);
  }

  // After building HTML, inject thumbnails for any source_image references
  const html = out.join("\n");
  return injectThumbnails(html);
}

// ── Inject thumbnails for source_image mentions ───────────
// Matches patterns like:
//   source_image: abc123, def456
//   (source_image: abc123, def456)
//   source_image: abc123
function injectThumbnails(html) {
  // Match "source_image:" followed by a comma-separated list of hex-like stems
  return html.replace(
    /source_image:\s*([\w,\s]+?)(?=[).;,<]|$)/gi,
    (match, stemList) => {
      const stems = stemList.split(",").map((s) => s.trim()).filter(Boolean);
      const thumbs = stems.map((stem) => {
        const filePath = state.picsMap[stem];
        if (!filePath) {
          // No image found — just render the stem as a dim code span
          return `<span class="img-stem missing" title="Image not found: ${stem}">${stem}</span>`;
        }
        // Use file:// URI; encode backslashes on Windows
        const uri = "file://" + filePath.replace(/\\/g, "/");
        return `<span class="thumb-wrap">
          <img class="source-thumb" src="${uri}" alt="${stem}" title="${stem}"
               loading="lazy" onerror="this.parentElement.classList.add('img-error')"/>
          <span class="img-stem">${stem.slice(0, 8)}…</span>
        </span>`;
      });

      return `<span class="source-image-group"><span class="source-label">source:</span>${thumbs.join("")}</span>`;
    }
  );
}

function formatInline(text) {
  text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/(?<!\*)\*(?!\*)(.+?)\*(?!\*)/g, "<em>$1</em>");
  text = injectThumbnails(text);
  return text;
}

// ── Scroll spy ───────────────────────────────────────────
function setupScrollSpy(count) {
  const pills = els.sectionNav.querySelectorAll(".nav-pill");
  const sections = Array.from({ length: count }, (_, i) => $(`section-${i}`)).filter(Boolean);

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const idx = parseInt(entry.target.id.replace("section-", ""));
          pills.forEach((p, i) => p.classList.toggle("active", i === idx));
        }
      });
    },
    { root: els.summaryBody, threshold: 0.3 }
  );

  sections.forEach((s) => observer.observe(s));
}

;

// ── Helpers ──────────────────────────────────────────────
function showWelcome() {
  els.viewer.classList.add("hidden");
  els.welcome.classList.remove("hidden");
}

// ── Lightbox ──────────────────────────────────────────────
const lightbox     = document.getElementById("lightbox");
const lbBackdrop   = document.getElementById("lightbox-backdrop");
const lbImg        = document.getElementById("lightbox-img");
const lbCaption    = document.getElementById("lightbox-caption");
const lbClose      = document.getElementById("lightbox-close");

function openLightbox(src, caption) {
  lbImg.src = src;
  lbImg.alt = caption;
  lbCaption.textContent = caption;
  lightbox.classList.remove("hidden");
  document.addEventListener("keydown", onLbKey);
}

function closeLightbox() {
  lightbox.classList.add("hidden");
  lbImg.src = "";
  document.removeEventListener("keydown", onLbKey);
}

function onLbKey(e) {
  if (e.key === "Escape") closeLightbox();
}

lbBackdrop.addEventListener("click", closeLightbox);
lbClose.addEventListener("click", closeLightbox);

// Event delegation — catches clicks on dynamically injected thumbnails
els.summaryBody.addEventListener("click", (e) => {
  const thumb = e.target.closest(".source-thumb");
  if (!thumb) return;
  openLightbox(thumb.src, thumb.title);
});

// ── Settings modal ────────────────────────────────────────
const settingsModal   = document.getElementById("settings-modal");
const settingsBackdrop= document.getElementById("settings-backdrop");
const settingsClose   = document.getElementById("settings-close");
const apiKeyInput     = document.getElementById("api-key-input");
const keyToggle       = document.getElementById("key-toggle");
const saveKeyBtn      = document.getElementById("save-key-btn");

document.getElementById("settings-btn").addEventListener("click", async () => {
  const [outputRoot, apiKey, authToken, vertexProject] = await Promise.all([
    window.api.getOutputRoot(),
    window.api.getApiKey(),
    window.api.getAuthToken(),
    window.api.getVertexProject(),
  ]);
  document.getElementById("output-root-input").value    = outputRoot;
  apiKeyInput.value = apiKey;
  document.getElementById("auth-token-input").value     = authToken;
  document.getElementById("vertex-project-input").value = vertexProject;
  settingsModal.classList.remove("hidden");
});

document.getElementById("browse-root-btn").addEventListener("click", async () => {
  const folder = await window.api.browseForFolder();
  if (folder) document.getElementById("output-root-input").value = folder;
});

function closeSettings() { settingsModal.classList.add("hidden"); }
settingsBackdrop.addEventListener("click", closeSettings);
settingsClose.addEventListener("click", closeSettings);

keyToggle.addEventListener("click", () => {
  apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
});

document.getElementById("auth-token-toggle").addEventListener("click", () => {
  const inp = document.getElementById("auth-token-input");
  inp.type = inp.type === "password" ? "text" : "password";
});

saveKeyBtn.addEventListener("click", async () => {
  await Promise.all([
    window.api.setOutputRoot(document.getElementById("output-root-input").value.trim()),
    window.api.setApiKey(apiKeyInput.value.trim()),
    window.api.setAuthToken(document.getElementById("auth-token-input").value.trim()),
    window.api.setVertexProject(document.getElementById("vertex-project-input").value.trim()),
  ]);
  closeSettings();
  // If output root changed, reload
  if (state.rootDir !== document.getElementById("output-root-input").value.trim()) {
    await loadFromOutputRoot();
  }
});

// ── Pipeline panel ────────────────────────────────────────
const pipelinePanel    = document.getElementById("pipeline-panel");
const pipelineTitle    = document.getElementById("pipeline-title");
const pipelineClose    = document.getElementById("pipeline-close");
const pipelineLog      = document.getElementById("pipeline-log");
const pipelineBar      = document.getElementById("pipeline-progress-bar");
const pipelineStatus   = document.getElementById("pipeline-status-text");
const pipelineCancelBtn= document.getElementById("pipeline-cancel-btn");

let pipelineTotal = 0;
let pipelineDone  = 0;

function openPipelinePanel(title) {
  pipelineTitle.textContent = title;
  pipelineLog.innerHTML = "";
  pipelineBar.style.width = "0%";
  pipelineStatus.textContent = "";
  pipelineClose.disabled = true;
  pipelineCancelBtn.disabled = false;
  pipelineTotal = 0;
  pipelineDone  = 0;
  pipelinePanel.classList.remove("hidden");
}

function closePipelinePanel() {
  pipelinePanel.classList.add("hidden");
  window.api.offPipelineEvent();
  // Reload the active species if one is open
  if (state.active) {
    const sp = state.species.find(s => s.name === state.active);
    if (sp) selectSpecies(sp);
  }
  // Refresh species list to update green dots
  if (state.rootDir) reloadSpeciesList();
}

pipelineClose.addEventListener("click", closePipelinePanel);
document.getElementById("pipeline-backdrop").addEventListener("click", () => {
  if (!pipelineClose.disabled) closePipelinePanel();
});

pipelineCancelBtn.addEventListener("click", async () => {
  await window.api.cancelPipeline();
  appendLog(null, "cancelled", "Pipeline cancelled by user.");
  pipelineClose.disabled = false;
  pipelineCancelBtn.disabled = true;
  pipelineStatus.textContent = "Cancelled.";
});

function appendLog(species, status, message) {
  const row = document.createElement("div");
  row.className = "log-row";

  if (species) {
    const sp = document.createElement("span");
    sp.className = "log-species";
    sp.textContent = species.replace(/_/g, " ");
    row.appendChild(sp);
  }

  const st = document.createElement("span");
  st.className = `log-status ${status}`;
  st.textContent = status;
  row.appendChild(st);

  if (message) {
    const msg = document.createElement("span");
    msg.className = "log-msg";
    msg.textContent = message;
    row.appendChild(msg);
  }

  pipelineLog.appendChild(row);
  pipelineLog.scrollTop = pipelineLog.scrollHeight;
}

async function reloadSpeciesList() {
  if (!state.rootDir) return;
  for (const sp of state.species) {
    const result = await window.api.refreshSpecies(state.rootDir, sp.name);
    if (result && !result.error) {
      sp.hasSummary    = result.hasSummary;
      sp.specimenCount = result.specimenCount;
    }
  }
  state.filtered = state.species.filter(s =>
    !els.searchInput.value || s.name.toLowerCase().includes(els.searchInput.value.toLowerCase())
  );
  renderSpeciesList();
  updateStats();
}

function setupPipelineEvents() {
  window.api.offPipelineEvent();
  window.api.onPipelineEvent((msg) => {
    switch (msg.event) {
      case "start":
        pipelineTotal = msg.total || 0;
        pipelineStatus.textContent = `0 / ${pipelineTotal} species`;
        break;
      case "progress":
        appendLog(msg.species, msg.status, msg.message);
        break;
      case "done":
        pipelineDone++;
        appendLog(msg.species, "done", "Summary written ✓");
        if (pipelineTotal > 0) {
          pipelineBar.style.width = `${Math.round((pipelineDone / pipelineTotal) * 100)}%`;
          pipelineStatus.textContent = `${pipelineDone} / ${pipelineTotal} complete`;
        }
        break;
      case "error":
        appendLog(msg.species, "error", msg.message);
        break;
      case "fatal":
        appendLog(null, "error", msg.message);
        pipelineClose.disabled = false;
        pipelineCancelBtn.disabled = true;
        break;
      case "finish":
        pipelineBar.style.width = "100%";
        pipelineStatus.textContent = `Finished — ${msg.succeeded} succeeded, ${msg.failed} failed`;
        pipelineTitle.textContent = "Pipeline complete";
        pipelineClose.disabled = false;
        pipelineCancelBtn.disabled = true;
        runAllBtn.disabled = false;
        generateBtn.disabled = false;
        break;
      case "closed":
        if (msg.code !== 0 && pipelineClose.disabled) {
          pipelineClose.disabled = false;
          pipelineCancelBtn.disabled = true;
        }
        break;
    }
  });
}

async function runPipeline(speciesName, language) {
  const apiKey = await window.api.getApiKey();
  if (!apiKey) {
    openPipelinePanel("Error");
    appendLog(null, "error", "No Gemini API key set. Open Settings (⚙) to add one.");
    pipelineClose.disabled = false;
    pipelineCancelBtn.disabled = true;
    return;
  }

  const title = speciesName
    ? `Summarising: ${speciesName.replace(/_/g, " ")} (${language || "English"})`
    : `Summarising all species (${language || "English"})…`;
  openPipelinePanel(title);
  runAllBtn.disabled   = true;
  generateBtn.disabled = true;
  setupPipelineEvents();

  const result = await window.api.runPipeline(state.rootDir, speciesName || null, language || "English");
  if (result && result.error) {
    appendLog(null, "error", result.error);
    pipelineClose.disabled   = false;
    pipelineCancelBtn.disabled = true;
    runAllBtn.disabled   = false;
    generateBtn.disabled = false;
  }
}

// Run all button — also shows language picker
runAllBtn.addEventListener("click", () => {
  if (!state.rootDir) return;
  openLangPicker(null);
});

// Per-species summarise button — shows language picker
generateBtn.addEventListener("click", () => {
  if (!state.rootDir || !state.active) return;
  openLangPicker(state.active);
});



// ── Voucher pipeline ──────────────────────────────────────
const voucherPanel       = document.getElementById("voucher-panel");
const voucherTitle       = document.getElementById("voucher-title");
const voucherClose       = document.getElementById("voucher-close");
const voucherLog         = document.getElementById("voucher-log");
const voucherBar         = document.getElementById("voucher-progress-bar");
const voucherStatus      = document.getElementById("voucher-status-text");
const voucherCancelBtn   = document.getElementById("voucher-cancel-btn");
const voucherThenSumBtn  = document.getElementById("voucher-then-summarise-btn");

function openVoucherPanel(title) {
  voucherTitle.textContent = title;
  voucherLog.innerHTML     = "";
  voucherBar.style.width   = "0%";
  voucherStatus.textContent= "";
  voucherClose.disabled    = true;
  voucherCancelBtn.disabled= false;
  voucherThenSumBtn.classList.add("hidden");
  voucherPanel.classList.remove("hidden");
}

function closeVoucherPanel() {
  voucherPanel.classList.add("hidden");
  voucherThenSumBtn.classList.add("hidden");
  window.api.offVoucherEvent();
}

function appendVoucherLog(status, message) {
  const row = document.createElement("div");
  row.className = "log-row";
  const st = document.createElement("span");
  st.className = `log-status ${status}`;
  st.textContent = status;
  row.appendChild(st);
  if (message) {
    const msg = document.createElement("span");
    msg.className = "log-msg";
    msg.textContent = message.trim();
    row.appendChild(msg);
  }
  voucherLog.appendChild(row);
  voucherLog.scrollTop = voucherLog.scrollHeight;
}

voucherClose.addEventListener("click", closeVoucherPanel);
document.getElementById("voucher-backdrop").addEventListener("click", () => {
  if (!voucherClose.disabled) closeVoucherPanel();
});

voucherCancelBtn.addEventListener("click", async () => {
  await window.api.cancelPipeline();
  appendVoucherLog("cancelled", "Cancelled by user.");
  voucherClose.disabled    = false;
  voucherCancelBtn.disabled= true;
});

// Core voucher pipeline runner — called both from processImagesBtn and createSpeciesBtn
async function runVoucherPipeline(rootDir, speciesName) {
  openVoucherPanel(`Processing images — ${speciesName.replace(/_/g, " ")}`);

  window.api.offVoucherEvent();
  window.api.onVoucherEvent((msg) => {
    switch (msg.event) {
      case "progress":
        appendVoucherLog(msg.status, msg.message);
        if (msg.status === "start")      voucherBar.style.width = "10%";
        if (msg.status === "processing") voucherBar.style.width = "40%";
        if (msg.status === "complete")   voucherBar.style.width = "90%";
        break;
      case "log":
        // verbose VoucherVision output — suppressed
        break;
      case "error":
      case "fatal":
        appendVoucherLog("error", msg.message);
        voucherClose.disabled    = false;
        voucherCancelBtn.disabled= true;
        break;
      case "done":
        voucherBar.style.width    = "100%";
        voucherTitle.textContent  = "VoucherVision complete ✓";
        voucherStatus.textContent = "Ready to summarise";
        voucherClose.disabled     = false;
        voucherCancelBtn.disabled = true;
        voucherThenSumBtn.classList.remove("hidden");
        window.api.refreshSpecies(rootDir, speciesName);
        break;
      case "closed":
        if (msg.code !== 0 && voucherClose.disabled) {
          voucherClose.disabled    = false;
          voucherCancelBtn.disabled= true;
        }
        break;
    }
  });

  const result = await window.api.runVoucherPipeline(rootDir, speciesName);
  if (result && result.error) {
    appendVoucherLog("error", result.error);
    voucherClose.disabled    = false;
    voucherCancelBtn.disabled= true;
  }
}

// "Generate summary now" — hide itself after click so it doesn't linger
voucherThenSumBtn.addEventListener("click", () => {
  voucherThenSumBtn.classList.add("hidden");
  closeVoucherPanel();
  if (state.rootDir && state.active) openLangPicker(state.active);
});

// processImagesBtn removed — image processing triggered from New Species modal only

// ── New species modal ─────────────────────────────────────
const newSpeciesModal   = document.getElementById("new-species-modal");
const newSpeciesClose   = document.getElementById("new-species-close");
const newSpeciesNameInp = document.getElementById("new-species-name");
const newSpeciesError   = document.getElementById("new-species-error");
const newSpeciesStatus  = document.getElementById("new-species-status");
const createSpeciesBtn  = document.getElementById("create-species-btn");
const imageDropZone     = document.getElementById("image-drop-zone");
const imageDropLabel    = document.getElementById("image-drop-label");
const imageDropCount    = document.getElementById("image-drop-count");

let selectedImages = [];

function openNewSpeciesModal() {
  newSpeciesNameInp.value = "";
  newSpeciesError.classList.add("hidden");
  newSpeciesStatus.textContent = "";
  selectedImages = [];
  imageDropLabel.textContent = "Click to select images";
  imageDropCount.textContent = "";
  newSpeciesModal.classList.remove("hidden");
  setTimeout(() => newSpeciesNameInp.focus(), 50);
}

function closeNewSpeciesModal() {
  newSpeciesModal.classList.add("hidden");
}

newSpeciesBtn.addEventListener("click", openNewSpeciesModal);
newSpeciesClose.addEventListener("click", closeNewSpeciesModal);
document.getElementById("new-species-backdrop").addEventListener("click", closeNewSpeciesModal);

// Image selection via click
imageDropZone.addEventListener("click", async () => {
  const paths = await window.api.pickImages();
  if (!paths.length) return;
  selectedImages = paths;
  imageDropLabel.textContent = "Images selected";
  imageDropCount.textContent = `${paths.length} file${paths.length !== 1 ? "s" : ""} ready`;
  imageDropZone.classList.add("has-images");
});

// Create species
createSpeciesBtn.addEventListener("click", async () => {
  newSpeciesError.classList.add("hidden");
  const name = newSpeciesNameInp.value.trim();

  if (!name) {
    newSpeciesError.textContent = "Please enter a species name.";
    newSpeciesError.classList.remove("hidden");
    return;
  }
  if (!selectedImages.length) {
    newSpeciesError.textContent = "Please select at least one image.";
    newSpeciesError.classList.remove("hidden");
    return;
  }

  createSpeciesBtn.disabled    = true;
  newSpeciesStatus.textContent = "Creating folder and copying images…";

  const result = await window.api.createSpecies(name, selectedImages);

  if (result.error) {
    newSpeciesError.textContent = result.error;
    newSpeciesError.classList.remove("hidden");
    newSpeciesStatus.textContent = "";
    createSpeciesBtn.disabled    = false;
    return;
  }

  // Add to state and sidebar
  const sp = {
    name:          result.folderName,
    displayName:   name,
    hasSummary:    false,
    specimenCount: 0,
  };
  state.rootDir = result.rootDir;
  state.species.push(sp);
  state.species.sort((a, b) => a.name.localeCompare(b.name));
  state.filtered    = state.species;
  reloadBtn.disabled    = false;
  runAllBtn.disabled    = false;
  newSpeciesBtn.disabled= false;

  renderSpeciesList();
  updateStats();
  closeNewSpeciesModal();

  // Select the species in the viewer
  await selectSpecies(sp);

  // Run VoucherVision directly — images are already in pics/, no re-picking needed
  await runVoucherPipeline(result.rootDir, result.folderName);

  createSpeciesBtn.disabled = false;
});

newSpeciesNameInp.addEventListener("keydown", e => {
  if (e.key === "Enter") createSpeciesBtn.click();
});

// ── Delete species modal ──────────────────────────────────
const deleteModal       = document.getElementById("delete-modal");
const deleteBackdrop    = document.getElementById("delete-backdrop");
const deleteModalClose  = document.getElementById("delete-modal-close");
const deleteSpeciesName = document.getElementById("delete-species-name");
const deleteCancelBtn   = document.getElementById("delete-cancel-btn");
const deleteConfirmBtn  = document.getElementById("delete-confirm-btn");

let pendingDelete = null; // { name, displayName }

function openDeleteModal(sp) {
  pendingDelete = sp;
  deleteSpeciesName.textContent = sp.displayName;
  deleteModal.classList.remove("hidden");
}

function closeDeleteModal() {
  deleteModal.classList.add("hidden");
  pendingDelete = null;
}

deleteBackdrop.addEventListener("click", closeDeleteModal);
deleteModalClose.addEventListener("click", closeDeleteModal);
deleteCancelBtn.addEventListener("click", closeDeleteModal);

deleteConfirmBtn.addEventListener("click", async () => {
  if (!pendingDelete || !state.rootDir) return;

  deleteConfirmBtn.disabled = true;
  deleteConfirmBtn.textContent = "Deleting…";

  const result = await window.api.deleteSpecies(state.rootDir, pendingDelete.name);

  if (result.error) {
    alert(`Could not delete: ${result.error}`);
    deleteConfirmBtn.disabled = false;
    deleteConfirmBtn.textContent = "Delete permanently";
    return;
  }

  // Remove from state
  state.species  = state.species.filter(s => s.name !== pendingDelete.name);
  state.filtered = state.filtered.filter(s => s.name !== pendingDelete.name);

  // If the deleted species was open in the viewer, go back to welcome
  if (state.active === pendingDelete.name) {
    state.active      = null;
    state.summaryText = null;
    showWelcome();
    if (leafletMap) { leafletMap.remove(); leafletMap = null; }
    document.getElementById("map-panel").style.display = "none";
  }

  closeDeleteModal();
  renderSpeciesList();
  updateStats();
  deleteConfirmBtn.disabled = false;
  deleteConfirmBtn.textContent = "Delete permanently";
});


