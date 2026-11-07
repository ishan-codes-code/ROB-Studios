// App-level child process diagnostics (Electron main process only).
//
// `app.on('child-process-gone')` is Electron's supported channel for
// non-renderer process termination (GPU, utility, zygote, ...).
// Renderer crashes arrive separately via `webContents`
// 'render-process-gone' and are handled in `./window.js`.
//
// Diagnostics only, deliberately: a GPU failure is logged with its
// type, reason, and exit code so a blank-window report can be
// correlated, but nothing here disables acceleration, relaunches
// helpers, or touches the Python worker — those actions need
// evidence this layer cannot provide.

export function describeChildProcessGone(details) {
  const type = typeof details?.type === 'string' && details.type !== ''
    ? details.type
    : 'unknown';
  const reason = typeof details?.reason === 'string' && details.reason !== ''
    ? details.reason
    : 'unknown';
  const exitCode = typeof details?.exitCode === 'number' ? details.exitCode : null;
  return { type: 'child-process-gone', processType: type, reason, exitCode };
}

export function handleChildProcessGone(details, { onEvent } = {}) {
  const event = describeChildProcessGone(details);
  if (typeof onEvent === 'function') {
    onEvent(event);
  }
  return event;
}
