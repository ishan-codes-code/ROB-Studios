import { app, BrowserWindow, crashReporter, dialog, ipcMain, net, protocol, safeStorage } from 'electron';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import started from 'electron-squirrel-startup';
import { createWorkerManager } from './python-worker.mjs';
import { resolvePythonTool } from './worker-protocol.mjs';
import { createExportManager } from './export-runner.mjs';
import { clearDevCredentials } from './credentials-store.mjs';
import { PRODUCT_NAME, WINDOWS_APP_USER_MODEL_ID, resolveUserDataPath } from './main/app-identity.mjs';
import { registerExportIpc } from './main/ipc/export.js';
import { registerProjectIpc } from './main/ipc/projects.js';
import { registerProcessingIpc } from './main/ipc/processing.js';
import { registerSettingsIpc } from './main/ipc/settings.js';
import { registerTtsIpc } from './main/ipc/tts.js';
import { registerVoiceConfigIpc } from './main/ipc/voice-configs.js';
import { registerDiagnosticsIpc } from './main/ipc/diagnostics.js';
import { createTtsCatalogLoader } from './tts-catalog.mjs';
import { createPromptPackLoader } from './prompt-packs.mjs';
import { registerProjectMediaProtocol } from './main/media-protocol.js';
import { createMainWindow } from './main/window.js';
import { handleChildProcessGone } from './main/process-events.js';
import { diagnosticsEnvironment, diagnosticsLogPath, recordDiagnosticsEvent } from './main/diagnostics-log.mjs';
import { flushApiActivity, recordApiActivityEvent, reconcileInterruptedRuns, resolveProjectMedia, sweepDeletionQuarantine } from './project-store.mjs';

app.setName(PRODUCT_NAME);
app.setPath('userData', resolveUserDataPath(app.getPath('appData'), fs.existsSync));
if (process.platform === 'win32') {
  app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
}

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// Custom project media scheme: standard + secure so <img>, <video>,
// and <audio> treat project:// URLs like https. Must register before
// the app is ready.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'project',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

// Repository root: <root>/electron/.vite/build in dev, <root>/electron/out
// in packaged builds. Worker and venv paths resolve from here so the app
// never depends on the process working directory.
function repoRoot() {
  if (app.isPackaged) {
    return null;
  }
  return path.join(__dirname, '..', '..', '..');
}

function pythonRuntimeContext() {
  const root = repoRoot();
  return {
    repoRoot: root,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    platform: process.platform,
    cwd: app.isPackaged ? app.getPath('userData') : root,
  };
}

const workerManager = createWorkerManager();
const exportManager = createExportManager();
let mainWindow = null;
const processingState = { activeProjectId: null, appQuitting: false };

function spawnSetup({ operation, provider, model, key }) {
  const launch = resolvePythonTool({ tool: 'provider-setup', ...pythonRuntimeContext() });
  if (!launch.executable) {
    const error = launch.reason === 'missing-resource'
      ? `Bundled Python runtime not found at ${launch.missing}. Reinstall ROB Studios.`
      : 'Python virtual environment is not configured.';
    return Promise.resolve({ ok: false, error });
  }
  return new Promise((resolve) => {
  // New vault callers pass an explicit provider id; the legacy
  // settings caller passes the stored provider object (treated as
  // Baseten-typed for backward compatibility).
  const providerId = typeof provider === 'string'
    ? provider
    : (provider?.id ?? 'baseten');
  const baseUrl = typeof provider === 'string' ? '' : (provider?.baseUrl ?? '');
  const modelId = model ?? provider?.model ?? '';
    const child = spawn(launch.executable, [...launch.argsPrefix, operation,
      '--base-url', baseUrl, '--model', modelId, '--provider', providerId], {
      stdio: ['ignore', 'pipe', 'ignore'],
      cwd: launch.cwd,
      env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '',
        AI_COMMENTATOR_PROVIDER_API_KEY: key },
    });
    let output = '';
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
    const timeout = setTimeout(() => { child.kill(); finish({ ok: false, error: 'Provider request timed out.', code: 'timeout' }); }, 25000);
    child.stdout.on('data', (chunk) => { output += String(chunk).slice(0, 32768); });
    child.on('error', () => { clearTimeout(timeout); finish({ ok: false, error: 'Could not start provider setup check.', code: 'transport' }); });
    child.on('close', () => {
      clearTimeout(timeout);
      try {
        const result = JSON.parse(output.trim().split(/\r?\n/).at(-1));
        if (!result || typeof result !== 'object' || result.ok !== true) {
          // Preserve the setup probe's structured, secret-free failure
          // ({error, code, status, provider, operation}) so the renderer
          // can show an actionable message instead of a generic one.
          if (result && typeof result === 'object' && typeof result.error === 'string') {
            return finish({
              ok: false,
              error: result.error,
              code: typeof result.code === 'string' ? result.code : 'unknown',
              status: typeof result.status === 'number' ? result.status : null,
              provider: typeof result.provider === 'string' ? result.provider : null,
              operation: typeof result.operation === 'string' ? result.operation : null,
              detail: typeof result.detail === 'string' ? result.detail.slice(0, 500) : null,
            });
          }
          return finish({ ok: false, error: 'Provider request failed. Check the URL, key, model, and provider compatibility.', code: 'unknown' });
        }
        finish(result);
      } catch { finish({ ok: false, error: 'Provider returned an invalid setup response.' }); }
    });
  });
}

// ROB window icon: dev builds read it from the source tree
// (electron/src/assets/icons), packaged builds from extraResource
// (process.resourcesPath/icon.png). Fail-soft: a missing file means
// no icon key, never a broken window.
function windowIconPath() {
  const candidate = app.isPackaged
    ? path.join(process.resourcesPath, 'icon.png')
    : path.join(__dirname, '..', '..', 'src', 'assets', 'icons', 'icon.png');
  try {
    return fs.existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

// Window/process diagnostics land on stderr (never stdout, never the
// renderer) and persist to the bounded diagnostics log so crash
// evidence survives the app closing.
function recordWindowEvent(event) {
  try {
    recordDiagnosticsEvent(app.getPath('userData'), event ?? { type: 'event' });
  } catch {
    // Diagnostics never break the app (the recorder is already
    // no-throw; this guards getPath itself).
  }
}

function logWindowEvent(event) {
  try {
    console.error(`[ROB window] ${event?.type ?? 'event'}: ${JSON.stringify(event ?? {})}`);
  } catch {
    // Diagnostics never break the app.
  }
  recordWindowEvent(event);
}

function diagnosticsPathOrNull() {
  try {
    return diagnosticsLogPath(app.getPath('userData'));
  } catch {
    return null;
  }
}

function createWindow() {
  mainWindow = createMainWindow({
    BrowserWindow,
    preloadPath: path.join(__dirname, 'preload.js'),
    devServerUrl: MAIN_WINDOW_VITE_DEV_SERVER_URL,
    rendererPath: path.join(__dirname, '../renderer', `${MAIN_WINDOW_VITE_NAME}/index.html`),
    iconPath: windowIconPath(),
    onEvent: logWindowEvent,
    diagnosticsPath: diagnosticsPathOrNull(),
  });
  recordWindowEvent({ type: 'window-created', packaged: app.isPackaged });
}

function sendWorkerEvent(message) {
  if (message && typeof message === 'object' && message.type === 'api_activity') {
    // Pair and persist before forwarding: Diagnostics and the
    // pipeline read the same records live and after restart.
    try {
      recordApiActivityEvent(
        app.getPath('userData'),
        processingState.activeProjectId ?? null,
        message.run_id ?? null,
        message.activity ?? null,
      );
    } catch {
      // Persistence never breaks event delivery.
    }
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    // Tag the run's project so the renderer routes events to the right
    // workspace session (additive: consumers ignore unknown fields).
    const tagged = message && typeof message === 'object' && message.projectId === undefined
      ? { ...message, projectId: processingState.activeProjectId ?? null }
      : message;
    mainWindow.webContents.send('worker-event', tagged);
  }
}

function sendExportEvent(message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('export-event', message);
  }
}


// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Local-only crash dumps: minidumps stay on this machine for
  // post-mortem inspection, nothing is ever uploaded anywhere.
  try {
    crashReporter.start({ uploadToServer: false });
  } catch {
    // Crash reporting is best effort; the app runs without it.
  }
  try {
    const gpuFeatureStatus = typeof app.getGPUFeatureStatus === 'function'
      ? app.getGPUFeatureStatus()
      : null;
    let crashDumpsPath = null;
    try {
      crashDumpsPath = app.getPath('crashDumps');
    } catch {
      crashDumpsPath = null;
    }
    let appVersion = null;
    try {
      appVersion = app.getVersion();
    } catch {
      appVersion = null;
    }
    // CPU identity matters for native-code crashes (SIGILL-class):
    // model from Node, instruction flags from /proc/cpuinfo on Linux.
    let cpuModel = null;
    let cpuFlags = null;
    try {
      cpuModel = os.cpus()?.[0]?.model ?? null;
    } catch {
      cpuModel = null;
    }
    if (process.platform === 'linux') {
      try {
        const match = fs.readFileSync('/proc/cpuinfo', 'utf8').match(/^flags\s*:\s*(.+)$/m);
        cpuFlags = match?.[1]?.trim() || null;
      } catch {
        cpuFlags = null;
      }
    }
    recordWindowEvent({
      type: 'app-ready',
      environment: diagnosticsEnvironment({
        appVersion,
        electronVersion: process.versions.electron ?? null,
        chromiumVersion: process.versions.chrome ?? null,
        nodeVersion: process.versions.node ?? null,
        platform: process.platform,
        arch: process.arch,
        cpuModel,
        cpuFlags,
        packaged: app.isPackaged,
        gpuFeatureStatus,
        crashDumpsPath,
      }),
    });
  } catch {
    // The ready milestone is best effort.
  }
  try {
    reconcileInterruptedRuns(app.getPath('userData'));
    void sweepDeletionQuarantine(app.getPath('userData')).catch(() => {
      // Best effort: tombstones survive for the next launch.
    });
  } catch {
    // userData unreadable: start anyway with no recovery.
  }
  registerProjectMediaProtocol({ protocol, net, pathToFileURL, app, resolveProjectMedia });
  createWindow();

  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Non-renderer process termination (GPU, utility, ...): diagnostics
// only. Recovery for the renderer's own crashes lives in
// createMainWindow; nothing here disables acceleration or restarts
// helpers without evidence.
app.on('child-process-gone', (_event, details) => {
  handleChildProcessGone(details, { onEvent: logWindowEvent });
});

// Never leave a worker running after the app exits.
app.on('before-quit', () => {
  // Temporary dev bypass: memory-held credentials vanish at shutdown.
  try { clearDevCredentials(); } catch { /* never block quit */ }
  try { flushApiActivity(app.getPath('userData'), { force: true }); } catch { /* best effort */ }
  if (workerManager.isBusy()) {
    // Best effort: the process tree is torn down with the session, but an
    // explicit terminate avoids a stray paid API call or file write.
    processingState.appQuitting = true;
    void workerManager.cancel({ killGraceMs: 1000 });
  }
  if (exportManager.isBusy()) {
    void exportManager.cancel({ killGraceMs: 1000 });
  }
});

const ttsCatalogLoader = createTtsCatalogLoader({ runtimeContext: pythonRuntimeContext });
const packsLoader = createPromptPackLoader({ runtimeContext: pythonRuntimeContext });

registerProcessingIpc({ ipcMain, app, dialog, fs, safeStorage, workerManager, state: processingState, repoRoot, runtimeContext: pythonRuntimeContext, sendWorkerEvent, getMainWindow: () => mainWindow, ttsCatalogLoader, packsLoader });

registerProjectIpc({ ipcMain, app, workerManager, exportManager });
registerExportIpc({ ipcMain, app, dialog, fs, exportManager, sendExportEvent, getMainWindow: () => mainWindow });
registerSettingsIpc({ ipcMain, app, safeStorage, spawnSetup, packsLoader });
registerTtsIpc({ ipcMain, app, safeStorage, repoRoot, runtimeContext: pythonRuntimeContext, catalogLoader: ttsCatalogLoader });
registerVoiceConfigIpc({ ipcMain, app, safeStorage });
registerDiagnosticsIpc({ ipcMain, app });

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
