export function createMainWindow({ BrowserWindow, preloadPath, devServerUrl, rendererPath }) {
  const window = new BrowserWindow({
    width: 900,
    height: 650,
    show: false,
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
