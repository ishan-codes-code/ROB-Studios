// Renderer lifecycle diagnostics (Electron main process only).
//
// The renderer reports sparse, allowlisted lifecycle milestones so a
// native crash leaves a timestamped trail of what the UI was doing
// (wizard exit, navigation, dashboard mount/hydration). The main
// process persists them to the bounded diagnostics log — the
// renderer never writes files itself.
//
// Trust boundary: event names must be allowlisted, metadata must be
// a small plain object, and the recorder scrubs secret-shaped keys
// again. Anything else is rejected; the renderer ignores failures.

import { recordDiagnosticsEvent } from '../diagnostics-log.mjs';

export const RENDERER_DIAGNOSTIC_EVENTS = Object.freeze([
  'onboarding.finish_later.clicked',
  'onboarding.completion.persist.started',
  'onboarding.completion.persist.finished',
  'onboarding.navigation.dashboard',
  'dashboard.mount.started',
  'dashboard.mount.completed',
  'dashboard.hydration.started',
  'dashboard.hydration.completed',
]);

function validMeta(meta) {
  if (meta === undefined || meta === null) return true;
  if (typeof meta !== 'object' || Array.isArray(meta)) return false;
  const entries = Object.entries(meta);
  if (entries.length > 16) return false;
  return entries.every(([key, value]) => (
    typeof key === 'string' && key.length >= 1 && key.length <= 64
    && (value === null || ['string', 'number', 'boolean'].includes(typeof value))
    && (typeof value !== 'string' || value.length <= 512)
  ));
}

export function registerDiagnosticsIpc({ ipcMain, app }) {
  ipcMain.handle('diagnostics-report', async (_event, name, meta) => {
    try {
      if (typeof name !== 'string' || !RENDERER_DIAGNOSTIC_EVENTS.includes(name)) {
        return { ok: false, error: 'Unknown diagnostic event.' };
      }
      if (!validMeta(meta)) {
        return { ok: false, error: 'Invalid diagnostic metadata.' };
      }
      const persisted = recordDiagnosticsEvent(app.getPath('userData'), { type: name, ...(meta ?? {}) });
      return { ok: persisted };
    } catch {
      return { ok: false, error: 'Could not record the diagnostic event.' };
    }
  });
}
