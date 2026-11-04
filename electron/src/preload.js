import { contextBridge, ipcRenderer, webUtils } from 'electron';

// Minimal, audited bridge between the renderer and the main process.
// The renderer never sees Node.js, the Python interpreter, or API keys:
// it can only start a processing job, request a cooperative stop,
// force-cancel it, and listen to worker events.
contextBridge.exposeInMainWorld('api', {
  processVideo: (videoPath, options) =>
    ipcRenderer.invoke('process-video', videoPath, options ?? {}),
  cancelProcessing: () => ipcRenderer.invoke('cancel-processing'),
  requestStop: () => ipcRenderer.invoke('request-stop'),
  visionStatus: () => ipcRenderer.invoke('vision-status'),
  loadSettings: () => ipcRenderer.invoke('settings-load'),
  saveSettings: (settings) => ipcRenderer.invoke('settings-save', settings),
  setProviderKey: (key) => ipcRenderer.invoke('credential-set', key),
  deleteProviderKey: () => ipcRenderer.invoke('credential-delete'),
  listCredentials: () => ipcRenderer.invoke('credential-list'),
  createCredential: (input) => ipcRenderer.invoke('credential-create', input),
  renameCredential: (id, name) => ipcRenderer.invoke('credential-rename', id, name),
  setCredentialKey: (id, key) => ipcRenderer.invoke('credential-set-key', id, key),
  setCredentialModel: (id, model) => ipcRenderer.invoke('credential-set-model', id, model),
  removeCredential: (id) => ipcRenderer.invoke('credential-remove', id),
  getDevBypass: () => ipcRenderer.invoke('dev-bypass-get'),
  setDevBypass: (enabled) => ipcRenderer.invoke('dev-bypass-set', enabled === true),
  testCredential: (id) => ipcRenderer.invoke('credential-test', id),
  verifyCredential: (id) => ipcRenderer.invoke('credential-verify', id),
  setCredentialEndpoint: (id, baseUrl) => ipcRenderer.invoke('credential-set-endpoint', id, baseUrl),
  discoverCustomModels: (input) => ipcRenderer.invoke('custom-models', input ?? {}),
  providerModels: (providerId) => ipcRenderer.invoke('provider-models', providerId),
  listPromptPacks: () => ipcRenderer.invoke('prompt-pack-list'),
  setPromptField: (packId, field, text) => ipcRenderer.invoke('prompt-pack-set', packId, field, text),
  resetPromptPack: (packId) => ipcRenderer.invoke('prompt-pack-reset', packId),
  getProjectConfig: (projectId) => ipcRenderer.invoke('project-config-get', projectId),
  setProjectConfig: (projectId, configuration) => ipcRenderer.invoke('project-config-set', projectId, configuration),
  getTtsCatalog: () => ipcRenderer.invoke('tts-catalog'),
  getTtsConfig: (projectId) => ipcRenderer.invoke('tts-config-get', projectId ?? null),
  setTtsConfig: (input) => ipcRenderer.invoke('tts-config-set', input),
  previewTts: (input) => ipcRenderer.invoke('tts-preview', input),
  listVoiceConfigs: () => ipcRenderer.invoke('voice-config-list'),
  createVoiceConfig: (input) => ipcRenderer.invoke('voice-config-create', input),
  updateVoiceConfig: (id, patch) => ipcRenderer.invoke('voice-config-update', id, patch),
  deleteVoiceConfig: (id) => ipcRenderer.invoke('voice-config-delete', id),
  providerSetup: (operation, settings) => ipcRenderer.invoke('provider-setup', operation, settings),
  selectVideo: () => ipcRenderer.invoke('select-video'),
  // Electron 32 removed File.path from the renderer; dropped/picked
  // files resolve their filesystem path through this sync bridge.
  getPathForFile: (file) => webUtils.getPathForFile(file),
  listProjects: () => ipcRenderer.invoke('list-projects'),
  createProject: (name, sourcePath, game) =>
    ipcRenderer.invoke('create-project', name, sourcePath, game ?? null),
  openProject: (id) => ipcRenderer.invoke('open-project', id),
  updateProject: (id, patch) => ipcRenderer.invoke('update-project', id, patch),
  deleteProject: (id) => ipcRenderer.invoke('delete-project', id),
  listArtifacts: (id) => ipcRenderer.invoke('list-artifacts', id),
  readArtifact: (id, kind, name) =>
    ipcRenderer.invoke('read-artifact', id, kind, name),
  getApiActivity: (id) => ipcRenderer.invoke('get-api-activity', id ?? null),
  onWorkerEvent: (callback) => {
    if (typeof callback !== 'function') {
      throw new TypeError('callback must be a function.');
    }
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('worker-event', listener);
    return () => ipcRenderer.removeListener('worker-event', listener);
  },
  exportVideo: (projectId, rows) => ipcRenderer.invoke('export-video', projectId, rows),
  cancelExport: () => ipcRenderer.invoke('cancel-export'),
  onExportEvent: (callback) => {
    if (typeof callback !== 'function') {
      throw new TypeError('callback must be a function.');
    }
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('export-event', listener);
    return () => ipcRenderer.removeListener('export-event', listener);
  },
});
