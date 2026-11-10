/*
 * GBIF image-download capture.
 *
 * Some institution image hosts serve occurrence images with
 * `Content-Disposition: attachment`, so navigating a webview to the image URL
 * triggers a DOWNLOAD (and, by default, an OS "Save As" dialog) instead of
 * rendering the image — which breaks the renderer's inline same-origin fetch.
 *
 * During an IRIS import we capture those downloads silently to a temp file
 * (setting a save path suppresses the dialog) and stream the bytes back to the
 * renderer, so forced-download images import exactly like inline ones.
 *
 * Capture is GATED to active import operations (setCapturing) so a user's own
 * downloads while browsing gbif.org still behave normally (dialog + save).
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { session } = require('electron');

let capturing = false;
let win = null;

function setCapturing(on) { capturing = !!on; }

function setup(mainWindow) {
  win = mainWindow;
  const ses = session.fromPartition('persist:gbif');
  // NB: the session keeps its default (Electron) User-Agent. Only when a host
  // rejects it does the renderer retry that one image with a plain-Chrome UA on
  // a per-webview basis — see gbif.js (fetchImageBytes / downloadViaWebview).
  ses.on('will-download', (event, item) => {
    if (!capturing) return; // user-initiated download while browsing → default behaviour (dialog)

    let tmp = null;
    try {
      tmp = path.join(os.tmpdir(), `iris-gbif-${Date.now()}-${Math.floor(Math.random() * 1e9)}`);
      item.setSavePath(tmp); // a preset path suppresses the Save dialog
    } catch (_) { /* fall through — done handler still reports failure */ }

    const url = item.getURL();
    const chain = (item.getURLChain && item.getURLChain()) || [url];

    item.once('done', (_e, state) => {
      let payload = { url, chain, ok: false };
      if (state === 'completed' && tmp) {
        try {
          payload = { url, chain, ok: true, dataBase64: fs.readFileSync(tmp).toString('base64') };
        } catch (_) { /* ok stays false */ }
      }
      try { if (tmp) fs.unlinkSync(tmp); } catch (_) {}
      if (win && !win.isDestroyed()) win.webContents.send('gbif:download', payload);
    });
  });
}

module.exports = { setup, setCapturing };
