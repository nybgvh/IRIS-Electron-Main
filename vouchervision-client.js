/*
 * VoucherVisionGO HTTP client (main process).
 *
 * Ported from IRIS_Electron/src/server/vouchervision/client.js. Submits one
 * image at a time to the sync `/process` endpoint using Node 18 built-ins
 * (fetch / FormData / Blob / AbortController) — NO Python and no extra npm HTTP
 * dependency. This replaces the old voucher_pipeline.py subprocess.
 *
 * Config is injected (this app has no server/config.js): callers pass a `vv`
 * object holding apiBaseUrl, apiKey, endpoint and the submission flags. Form
 * field shape + auth-header selection are faithful ports of the Python client
 * (booleans must be the literal string 'true'; `engines` is a repeated field).
 */

const ERR_4XX = "vv-client-bad-request";
const ERR_RETRYABLE = "vv-client-retryable";

function pickAuthHeader(apiKey) {
  // Bearer if the token looks like a JWT (has dots and is long), else X-API-Key —
  // the same heuristic as the Python client, so one token works for both shapes.
  if (apiKey && apiKey.length > 100 && apiKey.includes(".")) {
    return { Authorization: `Bearer ${apiKey}` };
  }
  return { "X-API-Key": apiKey };
}

// Per-call flag overrides (used to force ocr_only + skip_label_collage for
// document-style pages). Only a small whitelist may be overridden.
function withOptions(vv, options) {
  if (!options) return vv;
  const merged = { ...vv };
  for (const k of ["ocrOnly", "skipLabelCollage", "notebookMode"]) {
    if (options[k] !== undefined) merged[k] = options[k];
  }
  return merged;
}

function buildFormFields(vv) {
  const fields = [];
  if (vv.prompt)   fields.push(["prompt", vv.prompt]);
  if (vv.llmModel) fields.push(["llm_model", vv.llmModel]);

  if (vv.engines) {
    for (const e of String(vv.engines).split(",").map(s => s.trim()).filter(Boolean)) {
      fields.push(["engines", e]); // repeated field — server treats it as a list
    }
  }

  // Wire quirk: booleans must be the literal string 'true', and the field is
  // OMITTED when false (the server checks for presence + value).
  if (vv.ocrOnly)          fields.push(["ocr_only", "true"]);
  if (vv.notebookMode)     fields.push(["notebook_mode", "true"]);
  if (vv.skipLabelCollage) fields.push(["skip_label_collage", "true"]);
  if (vv.includeWfo)       fields.push(["include_wfo", "true"]);
  if (vv.includeCop90)     fields.push(["include_cop90", "true"]);

  if (vv.vertexProject) {
    fields.push(["vertex_project", vv.vertexProject]);
    fields.push(["vertex_region", vv.vertexRegion || "global"]);
  }
  return fields;
}

async function postWithTimeout(url, init, timeoutMs, extSignal) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  // Chain an external abort signal (user cancel) onto this request.
  if (extSignal) {
    if (extSignal.aborted) ctl.abort();
    else extSignal.addEventListener("abort", () => ctl.abort(), { once: true });
  }
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function classifyError(res) {
  // 4xx is a permanent rejection (bad request/auth/format) — no point retrying.
  if (res.status >= 400 && res.status < 500) return ERR_4XX;
  return ERR_RETRYABLE;
}

async function attemptSubmit(vvBase, { bytes, filename, mimeType, options }, signal) {
  const vv = withOptions(vvBase, options);
  const url = String(vv.apiBaseUrl).replace(/\/+$/, "") + (vv.endpoint || "/process");

  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mimeType || "application/octet-stream" }), filename);
  for (const [k, v] of buildFormFields(vv)) form.append(k, v);

  const headers = { Accept: "application/json", ...pickAuthHeader(vv.apiKey) };

  const res = await postWithTimeout(
    url, { method: "POST", headers, body: form }, vv.submitTimeoutMs || 300000, signal
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`VV /process ${res.status}: ${text.slice(0, 300)}`);
    err.kind = classifyError(res);
    err.status = res.status;
    throw err;
  }

  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    const text = await res.text().catch(() => "");
    const err = new Error(`VV /process returned non-JSON (${ct}): ${text.slice(0, 200)}`);
    err.kind = ERR_RETRYABLE;
    throw err;
  }

  return res.json();
}

/*
 * Submit one image to /process. Retries network errors and 5xx up to
 * `maxRetries` with exponential backoff (5s, 30s, 180s...); 4xx fails
 * immediately. `signal` (optional) aborts an in-flight/pending submission on
 * user cancel. Returns the parsed JSON dict; throws on terminal failure.
 */
async function submit(vv, { bytes, filename, mimeType, options }, signal) {
  const maxAttempts = (vv.maxRetries ?? 2) + 1;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal && signal.aborted) throw new Error("cancelled");
    try {
      return await attemptSubmit(vv, { bytes, filename, mimeType, options }, signal);
    } catch (err) {
      lastErr = err;
      if (err.kind === ERR_4XX) throw err;
      if (attempt === maxAttempts) throw err;
      if (signal && signal.aborted) throw err;
      const backoffMs = 5000 * Math.pow(6, attempt - 1); // 5s, 30s, 180s...
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
  throw lastErr;
}

/*
 * GET /auth-check. Returns true on 200, false otherwise. For a one-line boot/
 * settings diagnostic; never blocks.
 */
async function authCheck(vv) {
  if (!vv.apiBaseUrl || !vv.apiKey) return false;
  try {
    const url = String(vv.apiBaseUrl).replace(/\/+$/, "") + "/auth-check";
    const res = await postWithTimeout(url, {
      method: "GET",
      headers: { Accept: "application/json", ...pickAuthHeader(vv.apiKey) },
    }, 10000);
    return res.ok;
  } catch {
    return false;
  }
}

module.exports = { submit, authCheck };
