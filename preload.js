const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("clip", {
  getInfo: (url) => ipcRenderer.invoke("get-info", url),
  makeClip: (opts) => ipcRenderer.invoke("make-clip", opts),
  openFile: (p) => ipcRenderer.invoke("open-file", p),
  showFile: (p) => ipcRenderer.invoke("show-file", p),
  openFolder: () => ipcRenderer.invoke("open-folder"),
  onJob: (cb) => ipcRenderer.on("job", (_e, data) => cb(data)),
  onSetup: (cb) => ipcRenderer.on("setup", (_e, data) => cb(data)),
});
