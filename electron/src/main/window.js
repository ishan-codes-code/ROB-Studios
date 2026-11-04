export const TITLE_BAR_OVERLAY_HEIGHT = 36;
// Renderer load recovery: a failed main-frame load (dev server not
// ready, missing file) retries a few times, then shows an error page
// instead of sitting blank forever.
export const WINDOW_LOAD_MAX_ATTEMPTS = 3;
export const WINDOW_LOAD_RETRY_MS = 500;
// Renderer crash recovery: a terminated renderer reloads in place up
// to this many times per window lifetime, then lands on an error
// page. The lifetime cap (never reset by successful loads) is what
// stops a deterministically crashing renderer from reload-looping.
export const WINDOW_CRASH_MAX_RELOADS = 3;

export function loadErrorHtml(detail) {
  const safe = String(detail ?? 'the page could not be loaded.')
    .replace(/[<>&]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[char]));
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>ROB Studio</title></head>`
    + `<body style="margin:0;background:#09090a;color:#f1f1f1;font:14px system-ui,sans-serif;">`
    + `<div style="display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:24px;">`
    + `<div><h1 style="font-size:15px;margin:0 0 8px;">Could not load ROB Studio</h1>`
    + `<p style="color:#a1a1aa;max-width:420px;">${safe} Check that the development server is running, then close and reopen the window.</p></div>`
    + `</div></body></html>`;
}

export function createMainWindow({ BrowserWindow, preloadPath, devServerUrl, rendererPath, iconPath = null, platform = process.platform, scheduleRetry = (fn, ms) => setTimeout(fn, ms), onEvent = null }) {
  // Native caption controls stay visible on Windows: the overlay paints
  // the Obsidian surface behind them while the renderer draws the
  // matching title bar beneath. Other platforms keep the native frame.
  const useOverlay = platform === 'win32';
  const window = new BrowserWindow({
    width: 900,
    height: 650,
    show: false,
    backgroundColor: '#09090a',
    // ROB window icon (Windows taskbar/alt-tab, Linux dock/taskbar;
    // macOS uses the packaged .icns and ignores this key). Omitted
    // when no icon file resolved so window creation never breaks.
    ...(iconPath ? { icon: iconPath } : {}),
    ...(useOverlay
      ? {
          titleBarStyle: 'hidden',
          titleBarOverlay: {
            color: '#101011',
            symbolColor: '#f1f1f1',
            height: TITLE_BAR_OVERLAY_HEIGHT,
          },
        }
      : {}),
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  const loadTarget = () => {
    if (devServerUrl) {
      window.loadURL(devServerUrl);
    } else {
      window.loadFile(rendererPath);
    }
  };
  loadTarget();

  // A failed main-frame load retries with backoff, then lands on an
  // error page: every outcome is visible, none is a silent blank.
  // Guarded for minimal mocks (unit tests) that lack webContents.
  // The scheduled retry re-checks destruction: the window may close
  // while the backoff is pending, and loading into a destroyed
  // window throws.
  let loadAttempts = 1;
  window.webContents?.on?.('did-fail-load', (_event, _code, desc, _url, isMainFrame) => {
    if (isMainFrame === false || window.isDestroyed?.()) {
      return;
    }
    if (loadAttempts >= WINDOW_LOAD_MAX_ATTEMPTS) {
      onEvent?.({ type: 'load-failed', detail: String(desc ?? '') });
      window.webContents?.loadURL?.(
        `data:text/html;charset=utf-8,${encodeURIComponent(loadErrorHtml(desc))}`,
      );
      return;
    }
    loadAttempts += 1;
    scheduleRetry(() => {
      if (!window.isDestroyed?.()) {
        loadTarget();
      }
    }, WINDOW_LOAD_RETRY_MS * loadAttempts);
  });

  // Renderer-process termination (crash, OOM, kill): log the reason
  // and reload the same window in place — never a second window, and
  // never touching the Python worker or project state, which live
  // outside the renderer. `recovering` suppresses duplicate events
  // for one incident; the lifetime reload cap stops a renderer that
  // crashes on every boot from looping forever.
  let crashReloads = 0;
  let recovering = false;
  const showCrashPage = (reason, exitCode) => {
    const detail = `The renderer process ended (${reason ?? 'unknown reason'}`
      + `${typeof exitCode === 'number' ? `, exit code ${exitCode}` : ''}).`;
    window.webContents?.loadURL?.(
      `data:text/html;charset=utf-8,${encodeURIComponent(loadErrorHtml(detail))}`,
    );
  };
  window.webContents?.on?.('render-process-gone', (_event, details) => {
    if (window.isDestroyed?.() || recovering) {
      return;
    }
    const reason = details?.reason ?? 'unknown';
    const exitCode = typeof details?.exitCode === 'number' ? details.exitCode : null;
    if (crashReloads >= WINDOW_CRASH_MAX_RELOADS) {
      onEvent?.({ type: 'render-process-gone', reason, exitCode, recovered: false });
      showCrashPage(reason, exitCode);
      return;
    }
    crashReloads += 1;
    recovering = true;
    onEvent?.({ type: 'render-process-gone', reason, exitCode, recovered: true, attempt: crashReloads });
    if (typeof window.webContents?.reload === 'function') {
      window.webContents.reload();
    } else {
      loadTarget();
    }
  });
  window.webContents?.on?.('did-finish-load', () => {
    recovering = false;
  });

  // Responsiveness is diagnostics only: a busy renderer (video
  // processing, large workspace paint) must never be destroyed for
  // being temporarily slow.
  window.on?.('unresponsive', () => {
    onEvent?.({ type: 'renderer-unresponsive' });
  });
  window.on?.('responsive', () => {
    onEvent?.({ type: 'renderer-responsive' });
  });

  // Open maximized once the renderer is ready so the user never sees a
  // partially painted window. This is a normal resizable desktop window —
  // maximized, never exclusive fullscreen — so restore/resize keep working.
  window.once('ready-to-show', () => {
    if (window.isDestroyed()) {
      return;
    }
    window.maximize();
    window.show();
  });

  return window;
}
