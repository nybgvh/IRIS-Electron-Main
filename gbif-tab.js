// GBIF tab: browse gbif.org inside the app, collect specimens into a selection, then create a new
// project from the selection. Images are downloaded through the embedded browser session.
// Loaded after renderer.js (shares its globals: state, els, renderSpeciesList, updateStats, selectSpecies).
(function () {
  const HOME = "https://www.gbif.org/occurrence/search?occurrenceStatus=present&view=GALLERY&basisOfRecord=PRESERVED_SPECIMEN&mediaType=StillImage";
  const DOWNLOAD_CONCURRENCY = 3;
  const MAX_THUMBS = 200;

  // Same-origin fetch run inside a hidden webview that has navigated to the image URL.
  const FETCH_SNIPPET = `(async () => {
    const r = await fetch(location.href, { credentials: 'include' });
    if (!r.ok) throw new Error('http ' + r.status);
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (ct.startsWith('text/') || ct.includes('html') || ct.includes('json')) throw new Error('not-an-image:' + ct);
    const b = await r.blob();
    return await new Promise((res, rej) => { const fr = new FileReader();
      fr.onload = () => res(fr.result); fr.onerror = () => rej(fr.error || new Error('read failed')); fr.readAsDataURL(b); });
  })()`;
  const CLEAN_UA = navigator.userAgent.replace(/\s*(?:Electron|IRIS)\/\S+/gi, "").replace(/\s{2,}/g, " ").trim();

  const $ = (id) => document.getElementById(id);
  const g = { view: null, basket: new Map(), busy: false, running: false, cancel: false, currentId: null, onSearch: false };

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const parseId = (url) => { const m = String(url || "").match(/occurrence\/(\d+)/) || String(url || "").match(/[?&]entity=o_(\d+)/); return m ? m[1] : null; };
  const setStatus = (t) => { $("gbif-status").textContent = t || ""; };

  // ── show / hide the tab ────────────────────────────────────────────────────
  window.showGbifTab = function () {
    if (!state.rootDir) {
      alert("Please set an output folder in Settings before using GBIF.");
      $("settings-btn").click();
      return;
    }
    els.welcome.classList.add("hidden");
    els.viewer.classList.add("hidden");
    $("gbif-panel").classList.remove("hidden");
    els.speciesList.querySelectorAll(".species-item").forEach((el) => el.classList.remove("active"));
    $("gbif-tab-btn").classList.add("active");
    ensureView();
  };
  window.hideGbifTab = function () {
    const p = $("gbif-panel");
    if (p) p.classList.add("hidden");
    const b = $("gbif-tab-btn");
    if (b) b.classList.remove("active");
  };

  function ensureView() {
    if (g.view) return;
    const v = document.createElement("webview");
    v.setAttribute("partition", "persist:gbif");
    v.setAttribute("src", HOME);
    $("gbif-webview-wrap").appendChild(v);
    g.view = v;
    const nav = () => onNav();
    v.addEventListener("did-navigate", nav);
    v.addEventListener("did-navigate-in-page", nav); // gbif.org is a single-page app
    v.addEventListener("did-finish-load", nav);
    updateButtons();
  }

  function currentUrl() { try { return g.view ? g.view.getURL() : ""; } catch (_) { return ""; } }
  function onNav() {
    const u = currentUrl();
    g.currentId = parseId(u);
    g.onSearch = /\/occurrence\/(search|gallery)/.test(u);
    updateButtons();
  }

  function updateButtons() {
    const busy = g.busy || g.running;
    $("gbif-add").disabled = busy || !g.currentId;
    $("gbif-add").textContent = g.currentId ? `＋ Add specimen ${g.currentId}` : "＋ Add this specimen";
    $("gbif-add-search").disabled = busy || !g.onSearch;
    $("gbif-clear").disabled = busy || !g.basket.size;
    $("gbif-create").disabled = busy || !g.basket.size;
    $("gbif-back").disabled = !g.view;
    $("gbif-fwd").disabled = !g.view;
  }

  // ── selection ──────────────────────────────────────────────────────────────
  function renderTray() {
    const items = [...g.basket.values()];
    $("gbif-count").textContent = `${items.length} selected`;
    const shown = items.slice(0, MAX_THUMBS);
    $("gbif-strip").innerHTML = shown.map((o) =>
      `<div class="gbif-thumb" data-id="${esc(o.id)}" title="${esc((o.scientificName || "") + " — GBIF " + o.id)}">
         <img src="${esc(o.imageUrl)}" loading="lazy" referrerpolicy="no-referrer" />
         <button data-remove="${esc(o.id)}" title="Remove">×</button>
       </div>`).join("") + (items.length > MAX_THUMBS ? `<div class="gbif-more">+${items.length - MAX_THUMBS} more</div>` : "");
    updateButtons();
  }
  $("gbif-strip").addEventListener("click", (e) => {
    const id = e.target && e.target.getAttribute && e.target.getAttribute("data-remove");
    if (id) { g.basket.delete(id); renderTray(); }
  });
  // Hide thumbnails that fail to load (inline handlers are blocked by the page CSP; error events do not bubble)
  $("gbif-strip").addEventListener("error", (e) => { if (e.target && e.target.tagName === "IMG") e.target.remove(); }, true);
  $("gbif-clear").addEventListener("click", () => { g.basket.clear(); renderTray(); setStatus(""); });

  $("gbif-add").addEventListener("click", async () => {
    const id = parseId(currentUrl());
    if (!id) { setStatus("Open a specimen first (click an image on GBIF)."); return; }
    if (g.basket.has(id)) { setStatus(`GBIF ${id} is already selected.`); return; }
    g.busy = true; updateButtons(); setStatus(`Looking up ${id}…`);
    const res = await window.api.gbifLookup(id);
    g.busy = false;
    if (res.error) { setStatus(res.error); updateButtons(); return; }
    if (!res.occurrence.imageUrl) { setStatus(`GBIF ${id} has no image.`); updateButtons(); return; }
    g.basket.set(id, res.occurrence);
    setStatus(`Added ${id}.`);
    renderTray();
  });

  $("gbif-add-search").addEventListener("click", async () => {
    const n = Math.min(Math.max(parseInt($("gbif-search-n").value, 10) || 20, 1), 500);
    g.busy = true; updateButtons(); setStatus(`Reading up to ${n} specimens from this search…`);
    const res = await window.api.gbifEnumerate(currentUrl(), n);
    g.busy = false;
    if (res.error) { setStatus(res.error); updateButtons(); return; }
    let added = 0;
    for (const o of res.results) if (!g.basket.has(o.id)) { g.basket.set(o.id, o); added++; }
    setStatus(`Added ${added} specimen(s)${res.total ? ` — this search matches ${Number(res.total).toLocaleString()} in total` : ""}. Change the number and press again for more.`);
    renderTray();
  });

  $("gbif-back").addEventListener("click", () => { try { if (g.view.canGoBack()) g.view.goBack(); } catch (_) {} });
  $("gbif-fwd").addEventListener("click", () => { try { if (g.view.canGoForward()) g.view.goForward(); } catch (_) {} });
  $("gbif-home").addEventListener("click", () => { try { g.view.loadURL(HOME); } catch (_) {} });
  $("gbif-tab-btn").addEventListener("click", () => window.showGbifTab());

  // ── downloading images through the browser session ─────────────────────────
  const pendingDownloads = new Map();
  window.api.onGbifDownload((data) => {
    const key = pendingDownloads.has(data.url) ? data.url
      : (Array.isArray(data.chain) ? data.chain.find((u) => pendingDownloads.has(u)) : null);
    if (!key) return;
    const resolve = pendingDownloads.get(key);
    pendingDownloads.delete(key);
    resolve(data.ok && data.dataBase64 ? `data:image/jpeg;base64,${data.dataBase64}` : null);
  });

  function downloadViaWebview(imageUrl, userAgent) {
    return new Promise((resolve, reject) => {
      const fw = document.createElement("webview");
      fw.setAttribute("partition", "persist:gbif");
      if (userAgent) fw.setAttribute("useragent", userAgent);
      fw.className = "gbif-fetch-view";
      let settled = false;
      const finish = (fn, arg) => {
        if (settled) return; settled = true;
        clearTimeout(timer); pendingDownloads.delete(imageUrl);
        try { fw.remove(); } catch (_) {}
        fn(arg);
      };
      const timer = setTimeout(() => finish(reject, new Error("Timed out downloading the image.")), 60000);
      pendingDownloads.set(imageUrl, (dataUrl) => dataUrl ? finish(resolve, dataUrl) : finish(reject, new Error("The image could not be downloaded.")));
      fw.addEventListener("did-finish-load", async () => {
        try { finish(resolve, await fw.executeJavaScript(FETCH_SNIPPET, true)); }
        catch (e) { finish(reject, new Error("Could not read a valid image (" + ((e && e.message) || e) + ")")); }
      });
      fw.addEventListener("did-fail-load", (e) => {
        if (e.isMainFrame && e.errorCode !== -3) finish(reject, new Error("The image failed to load (code " + e.errorCode + ")."));
      });
      document.body.appendChild(fw);
      fw.src = imageUrl;
    });
  }
  async function fetchImage(imageUrl) {
    try { return await downloadViaWebview(imageUrl); }
    catch (err) {
      if (!CLEAN_UA || CLEAN_UA === navigator.userAgent) throw err;
      return await downloadViaWebview(imageUrl, CLEAN_UA); // retry once as plain Chrome
    }
  }

  // ── create project ─────────────────────────────────────────────────────────
  const folderOf = (name) => name.trim().replace(/\s+/g, "_");
  const nameTaken = (name) => {
    const f = folderOf(name).toLowerCase();
    return state.species.some((s) => String(s.name).toLowerCase() === f);
  };
  function suggestName() {
    const counts = new Map();
    for (const o of g.basket.values()) {
      const t = String(o.scientificName || "").trim().split(/\s+/).slice(0, 2).join(" ");
      if (t) counts.set(t, (counts.get(t) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0])[0] || "";
  }

  function projectError(msg) {
    const el = $("gbif-project-error");
    el.textContent = msg || "";
    el.classList.toggle("hidden", !msg);
  }
  function openProjectModal() {
    projectError("");
    $("gbif-project-name").value = suggestName();
    $("gbif-project-summary").textContent = `${g.basket.size} specimen image(s) will be downloaded into the new project. Transcription with Gemini starts automatically once the images are downloaded.`;
    $("gbif-project-status").textContent = "";
    $("gbif-project-create").textContent = "Create project";
    $("gbif-project-create").disabled = false;
    $("gbif-project-modal").classList.remove("hidden");
    setTimeout(() => $("gbif-project-name").focus(), 50);
  }
  function closeProjectModal() { if (!g.running) $("gbif-project-modal").classList.add("hidden"); }
  $("gbif-create").addEventListener("click", openProjectModal);
  $("gbif-project-close").addEventListener("click", closeProjectModal);
  $("gbif-project-backdrop").addEventListener("click", closeProjectModal);
  $("gbif-project-name").addEventListener("keydown", (e) => { if (e.key === "Enter") $("gbif-project-create").click(); });

  $("gbif-project-create").addEventListener("click", async () => {
    if (g.running) { g.cancel = true; $("gbif-project-status").textContent = "Stopping after the current downloads…"; return; }
    projectError("");
    const name = $("gbif-project-name").value.trim();
    if (!name) return projectError("Please enter a species name.");
    if (nameTaken(name)) return projectError(`"${name}" already exists. Delete it first or choose a different name.`);

    const created = await window.api.createSpecies(name, []); // also rejects a name that exists on disk
    if (created.error) return projectError(created.error);
    const { folderName, rootDir } = created;

    const items = [...g.basket.values()];
    let done = 0, saved = 0, failed = 0, next = 0;
    g.running = true; g.cancel = false; updateButtons();
    $("gbif-project-create").textContent = "Stop";
    await window.api.gbifCapture(true);
    const status = () => { $("gbif-project-status").textContent = `Downloading ${done}/${items.length}${failed ? ` (${failed} failed)` : ""}…`; };
    status();
    async function worker() {
      while (!g.cancel && next < items.length) {
        const o = items[next++];
        try {
          const dataUrl = await fetchImage(o.imageUrl);
          const r = await window.api.gbifSaveImage(rootDir, folderName, o.id, dataUrl);
          if (r.error) throw new Error(r.error);
          saved++;
        } catch (_) { failed++; }
        done++; status();
      }
    }
    try { await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, items.length) }, worker)); }
    finally { await window.api.gbifCapture(false); g.running = false; updateButtons(); }

    if (saved === 0) {
      await window.api.deleteSpecies(rootDir, folderName);
      $("gbif-project-create").textContent = "Create project";
      return projectError(g.cancel ? "Cancelled — nothing was saved." : "None of the images could be downloaded, so no project was created. The host may be blocking downloads.");
    }

    const sp = { name: folderName, displayName: name, hasSummary: false, specimenCount: 0 };
    state.rootDir = rootDir;
    state.species.push(sp);
    state.species.sort((a, b) => a.name.localeCompare(b.name));
    state.filtered = state.species;
    await window.api.refreshSpecies(rootDir, folderName).catch(() => {});
    renderSpeciesList();
    updateStats();
    g.basket.clear(); renderTray(); setStatus("");
    $("gbif-project-modal").classList.add("hidden");
    await selectSpecies(sp);
    if (failed) alert(`Created "${name}" with ${saved} image(s). ${failed} could not be downloaded.`);
    // GBIF specimens are herbarium sheets: transcribe the labels now (keep the project even if it fails)
    await runVoucherPipeline(rootDir, folderName, "gemini", true);
  });

  renderTray();
})();
