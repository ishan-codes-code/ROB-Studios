export const TITLE_BAR_OVERLAY_HEIGHT = 36;

export function createMainWindow({ BrowserWindow, preloadPath, devServerUrl, rendererPath, platform = process.platform }) {
  // Native caption controls stay visible on Windows: the overlay paints
  // the Obsidian surface behind them while the renderer draws the
  // matching title bar beneath. Other platforms keep the native frame.
  const useOverlay = platform === 'win32';
  const window = new BrowserWindow({
    width: 900,
    height: 650,
    show: false,
    backgroundColor: '#09090a',
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

  if (devServerUrl) {
    window.loadURL(devServerUrl);
  } else {
    window.loadFile(rendererPath);
  }

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
