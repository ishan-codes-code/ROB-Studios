// Renderer-side lifecycle reporting (renderer-safe, no IPC imports).
// Fire-and-forget milestones for the main-process diagnostics log so
// a renderer crash leaves a timestamped trail of what it was doing.
// Never throws, never blocks rendering, never carries secrets — the
// main process allowlists event names and scrubs metadata again.

export function reportRendererEvent(name, meta) {
  try {
    if (typeof window === 'undefined') return;
    const result = window.api?.reportRendererEvent?.(name, meta ?? {});
    if (result && typeof result.catch === 'function') {
      result.catch(() => {});
    }
  } catch {
    // Diagnostics never break the UI.
  }
}
