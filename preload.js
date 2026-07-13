const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // Auth
  register:        (u, p)   => ipcRenderer.invoke("auth-register", u, p),
  login:           (u, p)   => ipcRenderer.invoke("auth-login", u, p),
  logout:          ()        => ipcRenderer.invoke("auth-logout"),
  currentUser:     ()        => ipcRenderer.invoke("auth-current"),

  // Folder & species
  pickFolder:         ()        => ipcRenderer.invoke("pick-folder"),
  browseForFolder:    ()        => ipcRenderer.invoke("browse-for-folder"),
  getLastFolder:      ()        => ipcRenderer.invoke("get-last-folder"),
  loadFolderFromDb:   (r)       => ipcRenderer.invoke("load-folder-from-db", r),
  loadOutputRoot:     ()        => ipcRenderer.invoke("load-output-root"),
  createSpecies:      (n, imgs) => ipcRenderer.invoke("create-species", n, imgs),
  deleteSpecies:      (r, s)   => ipcRenderer.invoke("delete-species", r, s),
  readSummary:     (r, s)   => ipcRenderer.invoke("read-summary", r, s),
  resolvePics:     (r, s)   => ipcRenderer.invoke("resolve-pics", r, s),
  readSpecimens:   (r, s)   => ipcRenderer.invoke("read-specimens", r, s),
  refreshSpecies:  (r, s)   => ipcRenderer.invoke("refresh-species", r, s),

  // API key & credentials
  getOutputRoot:      ()        => ipcRenderer.invoke("get-output-root"),
  setOutputRoot:      (v)       => ipcRenderer.invoke("set-output-root", v),
  getApiKey:          ()        => ipcRenderer.invoke("get-api-key"),
  setApiKey:          (v)       => ipcRenderer.invoke("set-api-key", v),
  getAuthToken:       ()        => ipcRenderer.invoke("get-auth-token"),
  setAuthToken:       (v)       => ipcRenderer.invoke("set-auth-token", v),
  getVertexProject:   ()        => ipcRenderer.invoke("get-vertex-project"),
  setVertexProject:   (v)       => ipcRenderer.invoke("set-vertex-project", v),

  // Images
  pickImages:         ()        => ipcRenderer.invoke("pick-images"),
  copyImagesToPics:   (r,s,ps)  => ipcRenderer.invoke("copy-images-to-pics", r, s, ps),

  // Voucher pipeline
  runVoucherPipeline: (r,s)     => ipcRenderer.invoke("run-voucher-pipeline", r, s),
  onVoucherEvent:     (cb)      => ipcRenderer.on("voucher-event", (_e,msg) => cb(msg)),
  offVoucherEvent:    ()        => ipcRenderer.removeAllListeners("voucher-event"),

  // Red list pipeline
  runPipeline:        (r,s,lang) => ipcRenderer.invoke("run-pipeline", r, s, lang),
  cancelPipeline:     ()        => ipcRenderer.invoke("cancel-pipeline"),
  onPipelineEvent:    (cb)      => ipcRenderer.on("pipeline-event", (_e,msg) => cb(msg)),
  offPipelineEvent:   ()        => ipcRenderer.removeAllListeners("pipeline-event"),
});
