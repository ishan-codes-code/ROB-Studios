import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.jsx";
import { Button } from "@/components/ui/button.jsx";
import { Spinner } from "@/components/ui/spinner.jsx";
import {
  createInitialRunState,
} from "@/lib/worker-view.js";
import { RUN_MODES, buildProcessOptions, defaultRunMode, isAdaptiveMode, isValidAdaptiveMaxFrames } from "@/lib/run-options.js";
import {
  hydrateSession,
  updateSessionState,
  useWorkspaceSession,
} from "@/lib/workspace-sessions.js";
import useProjectAudio from "@/hooks/useProjectAudio.js";
import EditorCenter from "./workspace/EditorCenter.jsx";
import ProcessingInspector from "./workspace/ProcessingInspector.jsx";
import ProjectWorkspaceLayout from "./workspace/ProjectWorkspaceLayout.jsx";

/**
 * Dedicated workspace for one opened project. The source video lives in
 * the project's isolated directory (loaded via audited IPC); processing
 * runs project-bound so artifacts can never leak across projects.
 *
 * Run state lives in the per-project session store, not here: leaving
 * the editor unmounts this view (releasing video/audio resources) while
 * the session keeps receiving worker events, and reopening reattaches
 * to the exact same state. Audio lanes are honest empty states until
 * extraction/TTS land.
 */

/** One-line summary of measured result counts, or undefined when empty. */
function resultSummary(result) {
  if (!result || typeof result !== "object") {
    return undefined;
  }
  const parts = [];
  if (Number.isFinite(result.observations)) {
    parts.push(`${result.observations} observations`);
  }
  if (Number.isFinite(result.events)) {
    parts.push(`${result.events} events`);
  }
  if (Number.isFinite(result.commentary_lines)) {
    parts.push(`${result.commentary_lines} lines`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}
export default function WorkspaceSection({ projectId, inspectorOpen, onProjectLoaded, onBack, onNavigate }) {
  const session = useWorkspaceSession(projectId);
  const { run, project, runMode, adaptiveMaxFrames, runIsAdaptive, stopping, hydration, toastNotified } = session;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [visionConfigured, setVisionConfigured] = useState(false);
  const [visionMissing, setVisionMissing] = useState('API key');
  const [visionChecked, setVisionChecked] = useState(false);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState(null);
  const [stopError, setStopError] = useState(null);
  const mountedRef = useRef(true);
  // Single audio-discovery boundary for the editor: the commentary
  // timeline and the inspector script panel join the same files and
  // manifest entries, so both agree on every segment's state.
  const audio = useProjectAudio(project?.id ?? null, run.script, run.status);
  // One run toast per project: `loading` while accepted, replaced by
  // the terminal outcome. Cancelled/stopped runs dismiss it silently —
  // both follow explicit user actions whose inline pending and terminal
  // states already confirm the outcome.
  const runToastId = `processing-${projectId}`;

  const setRun = useCallback((next) => {
    updateSessionState(projectId, (current) => ({
      run: typeof next === "function" ? next(current.run) : next,
    }));
  }, [projectId]);

  useEffect(() => {
    mountedRef.current = true;
    let alive = true;
    async function load() {
      try {
        if (typeof window.api?.openProject !== "function") {
          throw new Error("Worker bridge unavailable (running outside Electron?).");
        }
        const res = await window.api.openProject(projectId);
        if (!res || res.ok !== true || !res.project) {
          throw new Error(res?.error ?? "Could not open the project.");
        }
        if (!alive) {
          return;
        }
        updateSessionState(projectId, { project: res.project });
        onProjectLoaded?.(res.project);
        // Restore prior work from persisted artifacts before showing
        // the editor, so a project with results never flashes fresh.
        // Resolves immediately when this session already hydrated.
        await hydrateSession(projectId, window.api);
        if (alive) {
          setLoading(false);
        }
        // Project-scoped readiness: the selected vault credential must
        // exist and be image-verified. The key value never reaches the
        // renderer. AI analysis is offered only when it can actually run.
        try {
          if (typeof window.api?.getProjectConfig === "function") {
            const config = await window.api.getProjectConfig(projectId);
            if (alive && config && config.ok === true) {
              const verified = config.credential?.verified === true;
              setVisionConfigured(verified);
              setVisionMissing(verified ? null : "verified API configuration");
              updateSessionState(projectId, (current) => (
                current.touched ? {} : { runMode: defaultRunMode(verified) }
              ));
            }
          }
        } catch {
          // Unknown: stay offline-safe.
        } finally {
          if (alive) {
            setVisionChecked(true);
          }
        }
      } catch (err) {
        if (alive) {
          setError(err?.message ?? "Could not open the project.");
          setLoading(false);
        }
      }
    }
    load();

    return () => {
      alive = false;
      mountedRef.current = false;
      toast.dismiss(`processing-${projectId}`);
    };
  }, [projectId, onProjectLoaded]);

  useEffect(() => {
    if (run.status === "processing" || run.status === "idle") {
      if (toastNotified !== null) {
        updateSessionState(projectId, { toastNotified: null });
      }
    } else if (toastNotified !== run.status) {
      updateSessionState(projectId, { toastNotified: run.status });
      if (run.status === "completed") {
        toast.success("Processing complete", {
          id: runToastId,
          description: resultSummary(run.result),
        });
      } else if (run.status === "failed") {
        toast.error("Processing failed", {
          id: runToastId,
          description: run.error?.message ?? undefined,
        });
      } else {
        toast.dismiss(runToastId);
      }
    }
    if (
      run.status === "completed" ||
      run.status === "failed" ||
      run.status === "cancelled" ||
      run.status === "stopped"
    ) {
      setCancelling(false);
      updateSessionState(projectId, { stopping: false, runIsAdaptive: false });
      if (project && typeof window.api?.updateProject === "function") {
        const terminal =
          run.status === "completed"
            ? "done"
            : run.status === "failed"
              ? "error"
              : run.status === "stopped"
                ? "stopped"
                : "cancelled";
        if (project.processingStatus !== terminal) {
          window.api
            .updateProject(project.id, { processingStatus: terminal })
            .catch(() => {});
          const nextStatus = terminal;
          updateSessionState(projectId, (current) => (
            current.project?.id === project.id
              ? { project: { ...current.project, processingStatus: nextStatus } }
              : {}
          ));
        }
      }
    }
  }, [run.status, project, projectId, runToastId, toastNotified, run.result, run.error]);

  const handleReadinessChange = useCallback((verified) => {
    const ready = verified === true;
    setVisionConfigured(ready);
    setVisionMissing(ready ? null : "verified API configuration");
    updateSessionState(projectId, { runMode: RUN_MODES.ADAPTIVE });
  }, [projectId]);

  const setRunMode = useCallback((next) => {
    updateSessionState(projectId, (current) => ({
      runMode: typeof next === "function" ? next(current.runMode) : next,
    }));
  }, [projectId]);

  const setAdaptiveMaxFrames = useCallback((next) => {
    updateSessionState(projectId, (current) => ({
      adaptiveMaxFrames: typeof next === "function" ? next(current.adaptiveMaxFrames) : next,
    }));
  }, [projectId]);

  const processing = run.status === "processing";
  const limitValid = isValidAdaptiveMaxFrames(adaptiveMaxFrames);
  const canStart =
    project && !starting && !cancelling && run.settled && !processing && limitValid;

  async function handleStart() {
    if (!canStart) {
      return;
    }
    const adaptive = isAdaptiveMode(runMode);
    setStarting(true);
    setCancelError(null);
    setStopError(null);
    updateSessionState(projectId, { stopping: false, runIsAdaptive: adaptive });
    try {
      const runOptions = buildProcessOptions(runMode, { adaptiveMaxFrames });
      const res = await window.api.processVideo(project.sourceVideo.path, {
        projectId: project.id,
        ...runOptions,
      });
      if (!mountedRef.current) {
        return;
      }
      if (!res || res.ok !== true) {
        setRun({
          ...createInitialRunState(),
          status: "failed",
          settled: true,
          error: {
            stage: "validation",
            message: res?.error ?? "Could not start processing.",
          },
        });
      } else if (typeof window.api?.updateProject === "function") {
        updateSessionState(projectId, { ttsRun: res.tts ?? null });
        toast.loading("Processing video…", { id: runToastId });
        window.api
          .updateProject(project.id, { processingStatus: "processing" })
          .catch(() => {});
        updateSessionState(projectId, (current) => (
          current.project ? { project: { ...current.project, processingStatus: "processing" } } : {}
        ));
      }
    } catch (err) {
      if (mountedRef.current) {
        setRun({
          ...createInitialRunState(),
          status: "failed",
          settled: true,
          error: {
            stage: "worker",
            message: err?.message ?? "Could not start processing.",
          },
        });
      }
    } finally {
      if (mountedRef.current) {
        setStarting(false);
      }
    }
  }

  async function handleCancel() {
    if (cancelling || run.status !== "processing") {
      return;
    }
    setCancelling(true);
    setCancelError(null);
    try {
      await window.api.cancelProcessing();
    } catch (err) {
      if (mountedRef.current) {
        setCancelling(false);
        setCancelError(err?.message ?? "Could not cancel processing.");
      }
    }
  }

  async function handleStop() {
    if (stopping || run.status !== "processing" || !runIsAdaptive) {
      return;
    }
    if (typeof window.api?.requestStop !== "function") {
      setStopError("Cooperative stop is unavailable in this build.");
      return;
    }
    updateSessionState(projectId, { stopping: true });
    setStopError(null);
    try {
      const res = await window.api.requestStop();
      if (!mountedRef.current) {
        return;
      }
      // Accepted means the control line reached the worker, not that the
      // run has stopped: `stopping` stays true until the terminal
      // `stopped` message lands. A rejection leaves the stopping state.
      if (!res || res.ok !== true || res.requested !== true) {
        updateSessionState(projectId, { stopping: false });
        setStopError(
          res && res.reason
            ? `Stop request was not accepted (${res.reason}).`
            : "Stop request was not accepted.",
        );
      }
    } catch (err) {
      if (mountedRef.current) {
        updateSessionState(projectId, { stopping: false });
        setStopError(err?.message ?? "Could not request stop.");
      }
    }
  }

  const restoring = hydration !== "ready";
  const mainContent = loading || restoring ? (
    <div className="flex h-full min-h-0 items-center justify-center gap-2 text-[13px] text-muted-foreground">
      <Spinner />
      {loading ? "Opening project…" : "Restoring workspace…"}
    </div>
  ) : error || !project ? (
    <div className="flex h-full min-h-0 flex-col items-start justify-center gap-3 p-5">
      <Button type="button" variant="ghost" onClick={onBack}>
        <ArrowLeft data-icon="inline-start" />
        Projects
      </Button>
      <Alert variant="destructive">
        <AlertTitle>Could not open the project</AlertTitle>
        <AlertDescription>{error ?? "Project not found."}</AlertDescription>
      </Alert>
    </div>
  ) : (
    <EditorCenter project={project} refreshSignal={run.status} script={run.script} runStatus={run.status} audio={audio} onBack={onBack} />
  );

  const inspectorContent = project ? (
    <ProcessingInspector
      project={project}
      run={run}
      apiActivity={session.apiActivity ?? []}
      runMode={runMode}
      setRunMode={setRunMode}
      visionConfigured={visionConfigured}
      visionMissing={visionMissing}
      visionChecked={visionChecked}
      canStart={canStart}
      starting={starting}
      cancelling={cancelling}
      cancelError={cancelError}
      stopping={stopping}
      stopError={stopError}
      runIsAdaptive={runIsAdaptive}
      adaptiveMaxFrames={adaptiveMaxFrames}
      setAdaptiveMaxFrames={setAdaptiveMaxFrames}
      ttsRun={session.ttsRun}
      script={run.script}
      runStatus={run.status}
      audio={audio}
      onStart={handleStart}
      onCancel={handleCancel}
      onStop={handleStop}
      onReadinessChange={handleReadinessChange}
      onNavigate={onNavigate}
    />
  ) : (
    <div className="flex h-full items-center justify-center px-4 text-[12px] text-muted-foreground">
      {loading ? "Loading project inspector…" : "Project details unavailable"}
    </div>
  );

  return (
    <ProjectWorkspaceLayout
      main={mainContent}
      inspector={inspectorContent}
      inspectorOpen={inspectorOpen}
    />
  );
}
