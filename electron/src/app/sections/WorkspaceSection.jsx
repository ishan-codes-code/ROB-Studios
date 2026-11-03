import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.jsx";
import { Button } from "@/components/ui/button.jsx";
import { Spinner } from "@/components/ui/spinner.jsx";
import {
  applyWorkerMessage,
  createInitialRunState,
} from "@/lib/worker-view.js";
import { ADAPTIVE_DEFAULT_MAX_FRAMES, RUN_MODES, buildProcessOptions, defaultRunMode, isAdaptiveMode } from "@/lib/run-options.js";
import useProjectAudio from "@/hooks/useProjectAudio.js";
import EditorCenter from "./workspace/EditorCenter.jsx";
import ProcessingInspector from "./workspace/ProcessingInspector.jsx";
import ProjectWorkspaceLayout from "./workspace/ProjectWorkspaceLayout.jsx";

/**
 * Dedicated workspace for one opened project. The source video lives in
 * the project's isolated directory (loaded via audited IPC); processing
 * runs project-bound so artifacts can never leak across projects.
 * Audio lanes are honest empty states until extraction/TTS land.
 */
export default function WorkspaceSection({ projectId, inspectorOpen, onProjectLoaded, onBack }) {
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [run, setRun] = useState(() => createInitialRunState());
  const [runMode, setRunMode] = useState(RUN_MODES.ADAPTIVE);
  const [visionConfigured, setVisionConfigured] = useState(false);
  const [visionMissing, setVisionMissing] = useState('API key');
  const [visionChecked, setVisionChecked] = useState(false);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState(null);
  const [adaptiveMaxFrames, setAdaptiveMaxFrames] = useState(
    ADAPTIVE_DEFAULT_MAX_FRAMES,
  );
  const [requestTts, setRequestTts] = useState(false);
  // True while a cooperative stop was accepted and the run is still
  // alive. Set only after the main process confirms acceptance; the
  // worker's terminal message clears it.
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState(null);
  // Whether the active run is adaptive (captured at start so a later
  // mode change cannot rewire a live run's controls).
  const [runIsAdaptive, setRunIsAdaptive] = useState(false);
  const mountedRef = useRef(true);
  // Single audio-discovery boundary for the editor: the commentary
  // timeline and the inspector script panel join the same files and
  // manifest entries, so both agree on every segment's state.
  const audio = useProjectAudio(project?.id ?? null, run.script, run.status);

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
        if (alive) {
          setProject(res.project);
          onProjectLoaded?.(res.project);
          setRun((prev) =>
            res.project.processingStatus === "processing"
              ? { ...prev, status: "processing", settled: false }
              : prev,
          );
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
              setRunMode(defaultRunMode(verified));
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

    let unsubscribe;
    if (typeof window.api?.onWorkerEvent === "function") {
      unsubscribe = window.api.onWorkerEvent((message) => {
        if (mountedRef.current) {
          setRun((prev) => applyWorkerMessage(prev, message));
        }
      });
    }
    return () => {
      alive = false;
      mountedRef.current = false;
      if (unsubscribe) {
        unsubscribe();
      }
    };
  }, [projectId, onProjectLoaded]);

  useEffect(() => {
    if (
      run.status === "completed" ||
      run.status === "failed" ||
      run.status === "cancelled" ||
      run.status === "stopped"
    ) {
      setCancelling(false);
      setStopping(false);
      setRunIsAdaptive(false);
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
          setProject((current) =>
            current?.id === project.id
              ? { ...current, processingStatus: terminal }
              : current,
          );
        }
      }
    }
  }, [run.status, project]);

  const handleReadinessChange = useCallback((verified) => {
    const ready = verified === true;
    setVisionConfigured(ready);
    setVisionMissing(ready ? null : "verified API configuration");
    setRunMode(RUN_MODES.ADAPTIVE);
  }, []);

  const processing = run.status === "processing";
  const canStart =
    project && !starting && !cancelling && run.settled && !processing;

  async function handleStart() {
    if (!canStart) {
      return;
    }
    const adaptive = isAdaptiveMode(runMode);
    setStarting(true);
    setCancelError(null);
    setStopError(null);
    setStopping(false);
    setRunIsAdaptive(adaptive);
    try {
      const runOptions = buildProcessOptions(runMode, { adaptiveMaxFrames, requestTts });
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
        window.api
          .updateProject(project.id, { processingStatus: "processing" })
          .catch(() => {});
        setProject((current) => ({ ...current, processingStatus: "processing" }));
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
    setStopping(true);
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
        setStopping(false);
        setStopError(
          res && res.reason
            ? `Stop request was not accepted (${res.reason}).`
            : "Stop request was not accepted.",
        );
      }
    } catch (err) {
      if (mountedRef.current) {
        setStopping(false);
        setStopError(err?.message ?? "Could not request stop.");
      }
    }
  }

  const mainContent = loading ? (
    <div className="flex h-full min-h-0 items-center justify-center gap-2 text-[13px] text-muted-foreground">
      <Spinner />
      Opening project…
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
      requestTts={requestTts}
      setRequestTts={setRequestTts}
      script={run.script}
      runStatus={run.status}
      audio={audio}
      onStart={handleStart}
      onCancel={handleCancel}
      onStop={handleStop}
      onReadinessChange={handleReadinessChange}
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
