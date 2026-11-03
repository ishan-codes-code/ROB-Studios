import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

/**
 * Single owner of video-export state for the editor toolbar. Subscribes
 * to main-process `export-event` phases for one project, exposes
 * start/cancel with a re-entrancy guard, and owns the export
 * notifications — no other component toasts export outcomes.
 *
 * States: `idle`, `starting` (dialog + validation), `exporting`
 * (determinate progress), `done` (output path), `error` (message).
 * Success is reported only when the `done` phase arrives.
 */
export default function useVideoExport(projectId) {
  const [exportState, setExportState] = useState({
    status: "idle",
    percent: 0,
    outputPath: null,
    error: null,
  });
  const exportLiveRef = useRef(false);
  const busyRef = useRef(false);

  useEffect(() => {
    setExportState({ status: "idle", percent: 0, outputPath: null, error: null });
    exportLiveRef.current = false;
    busyRef.current = false;
    if (typeof window.api?.onExportEvent !== "function") {
      return undefined;
    }
    const unsubscribe = window.api.onExportEvent((event) => {
      if (!event || event.projectId !== projectId) {
        return;
      }
      if (event.phase === "progress") {
        const total = event.totalUs;
        const percent =
          typeof event.completedUs === "number" && typeof total === "number" && total > 0
            ? Math.min(100, Math.max(0, Math.round((event.completedUs / total) * 100)))
            : 0;
        setExportState((prev) => ({ ...prev, status: "exporting", percent }));
      } else if (event.phase === "done") {
        exportLiveRef.current = false;
        busyRef.current = false;
        const outputPath = typeof event.outputPath === "string" ? event.outputPath : null;
        setExportState({
          status: "done",
          percent: 100,
          outputPath,
          error: null,
        });
        toast.success("Export complete", {
          description: outputPath?.split(/[/\\]/).pop() ?? undefined,
        });
      } else if (event.phase === "error") {
        exportLiveRef.current = false;
        busyRef.current = false;
        const message = typeof event.error === "string" ? event.error : "Export failed.";
        setExportState({
          status: "error",
          percent: 0,
          outputPath: null,
          error: message,
        });
        toast.error("Export failed", { description: message });
      } else if (event.phase === "cancelled") {
        exportLiveRef.current = false;
        busyRef.current = false;
        setExportState({ status: "idle", percent: 0, outputPath: null, error: null });
      }
    });
    return () => {
      unsubscribe();
      if (exportLiveRef.current && typeof window.api?.cancelExport === "function") {
        exportLiveRef.current = false;
        busyRef.current = false;
        void window.api.cancelExport();
      }
    };
  }, [projectId]);

  const startExport = useCallback(
    async (rows) => {
      if (busyRef.current || typeof window.api?.exportVideo !== "function") {
        return;
      }
      busyRef.current = true;
      setExportState({ status: "starting", percent: 0, outputPath: null, error: null });
      try {
        const res = await window.api.exportVideo(projectId, rows);
        if (!res || res.ok !== true) {
          busyRef.current = false;
          setExportState({
            status: "error",
            percent: 0,
            outputPath: null,
            error: res?.error ?? "Export could not start.",
          });
        } else if (res.canceled) {
          busyRef.current = false;
          setExportState({ status: "idle", percent: 0, outputPath: null, error: null });
        } else {
          exportLiveRef.current = true;
          setExportState((prev) => ({ ...prev, status: "exporting" }));
        }
      } catch {
        busyRef.current = false;
        setExportState({ status: "error", percent: 0, outputPath: null, error: "Export could not start." });
      }
    },
    [projectId],
  );

  const cancelExport = useCallback(async () => {
    try {
      await window.api.cancelExport();
    } catch {
      // The cancelled event (or its absence) settles the state below.
    }
    exportLiveRef.current = false;
    busyRef.current = false;
    setExportState({ status: "idle", percent: 0, outputPath: null, error: null });
  }, []);

  return { exportState, startExport, cancelExport };
}
