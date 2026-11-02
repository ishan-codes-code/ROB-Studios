import { contextBridge, ipcRenderer } from 'electron';

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
  testCredential: (id) => ipcRenderer.invoke('credential-test', id),
  verifyCredential: (id) => ipcRenderer.invoke('credential-verify', id),
  providerModels: (providerId) => ipcRenderer.invoke('provider-models', providerId),
  listGameProfiles: () => ipcRenderer.invoke('game-profile-list'),
  createGameProfile: (input) => ipcRenderer.invoke('game-profile-create', input),
  updateGameProfile: (id, patch) => ipcRenderer.invoke('game-profile-update', id, patch),
  deleteGameProfile: (id) => ipcRenderer.invoke('game-profile-delete', id),
  listPresets: (profileId) => ipcRenderer.invoke('preset-list', profileId ?? null),
  createPreset: (input) => ipcRenderer.invoke('preset-create', input),
  updatePreset: (id, patch) => ipcRenderer.invoke('preset-update', id, patch),
  duplicatePreset: (id, name) => ipcRenderer.invoke('preset-duplicate', id, name ?? null),
  deletePreset: (id) => ipcRenderer.invoke('preset-delete', id),
  getProjectConfig: (projectId) => ipcRenderer.invoke('project-config-get', projectId),
  setProjectConfig: (projectId, configuration) => ipcRenderer.invoke('project-config-set', projectId, configuration),
  providerSetup: (operation, settings) => ipcRenderer.invoke('provider-setup', operation, settings),
  selectVideo: () => ipcRenderer.invoke('select-video'),
  listProjects: () => ipcRenderer.invoke('list-projects'),
  createProject: (name, sourcePath) =>
    ipcRenderer.invoke('create-project', name, sourcePath),
  openProject: (id) => ipcRenderer.invoke('open-project', id),
  updateProject: (id, patch) => ipcRenderer.invoke('update-project', id, patch),
  deleteProject: (id) => ipcRenderer.invoke('delete-project', id),
  listArtifacts: (id) => ipcRenderer.invoke('list-artifacts', id),
  readArtifact: (id, kind, name) =>
    ipcRenderer.invoke('read-artifact', id, kind, name),
  onWorkerEvent: (callback) => {
    if (typeof callback !== 'function') {
      throw new TypeError('callback must be a function.');
    }
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('worker-event', listener);
    return () => ipcRenderer.removeListener('worker-event', listener);
  },
});
