import { useMemo, useRef } from "react";
import { ArrowLeft, Activity, Check, Download, X } from "lucide-react";
import { Button } from "@/components/ui/button.jsx";
import { Progress } from "@/components/ui/progress.jsx";
import { Separator } from "@/components/ui/separator.jsx";
import { Spinner } from "@/components/ui/spinner.jsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog.jsx";
import ArtifactBrowser from "@/components/ArtifactBrowser.jsx";
import CommentaryTimeline from "./CommentaryTimeline.jsx";
import VideoPreview from "./VideoPreview.jsx";
import useVideoExport from "@/hooks/useVideoExport.js";
import { buildAudioRows } from "@/lib/audio-rows.js";

const RUN_STATUS_META = {
  idle: { dot: "bg-muted-foreground", label: "Idle" },
  processing: { dot: "bg-primary", label: "Processing" },
  completed: { dot: "bg-success", label: "Completed" },
  failed: { dot: "bg-destructive", label: "Failed" },
  cancelled: { dot: "bg-warning", label: "Cancelled" },
  stopped: { dot: "bg-warning", label: "Stopped" },
};

function RunStatusPill({ runStatus }) {
  const meta = RUN_STATUS_META[runStatus] ?? RUN_STATUS_META.idle;
  return (
    <span className="flex shrink-0 items-center gap-1.5" role="status" aria-label={`Run status: ${meta.label}`}>
      <span aria-hidden className={`size-1.5 rounded-full ${meta.dot}`} />
      <span className="text-[11px] text-muted-foreground">{meta.label}</span>
    </span>
  );
}

function ExportCluster({ projectId, readyCount, view, exportState, onStart, onCancel }) {
  const { status, percent, outputPath, error } = exportState;
  if (status === "starting") {
    return (
      <span className="flex shrink-0 items-center">
        <Button type="button" size="sm" variant="default" disabled>
          <Spinner data-icon="inline-start" />
          Preparing…
        </Button>
      </span>
    );
  }
  if (status === "exporting") {
    return (
      <span className="flex shrink-0 items-center gap-2">
        <Progress
          value={percent}
          max={100}
          aria-label={`Exporting video, ${percent}%`}
          className="h-1 w-24"
        />
        <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
          {percent}%
        </span>
        <Button type="button" size="icon-sm" variant="ghost" onClick={onCancel} title="Cancel export" aria-label="Cancel export">
          <X aria-hidden />
        </Button>
      </span>
    );
  }
  if (status === "done") {
    return (
      <span className="flex min-w-0 shrink-0 items-center gap-2">
        <span
          className="flex min-w-0 items-center gap-1.5 text-[12px] text-foreground"
          title={outputPath ?? "Export complete"}
        >
          <Check className="size-3.5 shrink-0 text-success" aria-hidden />
          <span className="max-w-40 truncate">
            {outputPath?.split(/[/\\]/).pop() ?? "Export complete"}
          </span>
        </span>
        <Button type="button" size="sm" variant="secondary" onClick={() => onStart(view.rows)} title="Export video again">
          <Download data-icon="inline-start" />
          Export
        </Button>
      </span>
    );
  }
  return (
    <span className="flex min-w-0 shrink-0 items-center gap-2">
      {status === "error" ? (
        <span
          role="alert"
          title={error ?? "Export failed."}
          className="max-w-48 truncate text-[12px] text-destructive"
        >
          {error ?? "Export failed."}
        </span>
      ) : null}
      <Button
        type="button"
        size="sm"
        variant="default"
        onClick={() => onStart(view.rows)}
        disabled={readyCount === 0 || !projectId}
        title={
          !projectId
            ? "Open a project to export."
            : readyCount === 0
              ? "Export needs commentary audio — run with a TTS voice configured."
              : "Export video with commentary"
        }
      >
        <Download data-icon="inline-start" />
        Export
      </Button>
    </span>
  );
}

/**
 * Central editor column: toolbar, gameplay preview, and the commentary
 * timeline. The toolbar owns the primary Export action (state from the
 * shared export controller, rows from the lifted audio-row join); the
 * timeline below focuses on audio visualization and playback.
 * Diagnostics live behind a secondary dialog so artifact browsing never
 * competes with the preview.
 */
export default function EditorCenter({
  project,
  refreshSignal,
  script = null,
  runStatus = "idle",
  audio = null,
  onBack,
}) {
  const videoRef = useRef(null);
  const segments = useMemo(
    () => (Array.isArray(script?.segments) ? script.segments : []),
    [script],
  );
  const live = runStatus === "processing";
  const view = useMemo(
    () =>
      buildAudioRows({
        segments,
        files: audio?.audioFiles ?? [],
        entries: audio?.ttsEntries ?? null,
        live,
      }),
    [segments, audio, live],
  );
  const { exportState, startExport, cancelExport } = useVideoExport(project.id);

  function handleDiagnosticsOpenChange(open) {
    if (open) {
      videoRef.current?.pause();
    }
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <div className="flex h-11 min-w-0 shrink-0 items-center gap-2.5 border-b border-border bg-surface px-3">
        <Button type="button" size="sm" variant="ghost" onClick={onBack}>
          <ArrowLeft data-icon="inline-start" />
          Projects
        </Button>
        <Separator orientation="vertical" className="h-4" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold tracking-[-0.01em] text-foreground">
          {project.name}
        </span>
        <RunStatusPill runStatus={runStatus} />
        <Separator orientation="vertical" className="h-4" />
        <ExportCluster
          projectId={project.id}
          readyCount={view.ready}
          view={view}
          exportState={exportState}
          onStart={startExport}
          onCancel={cancelExport}
        />
        <Separator orientation="vertical" className="h-4" />
        <Dialog onOpenChange={handleDiagnosticsOpenChange}>
          <DialogTrigger asChild>
            <Button type="button" size="sm" variant="ghost" title="Inspect frames, observations, and run artifacts">
              <Activity data-icon="inline-start" />
              Diagnostics
            </Button>
          </DialogTrigger>
          <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle>Project diagnostics</DialogTitle>
              <DialogDescription>
                Frames, observations, match state, events, commentary, and audio artifacts for {project.name}.
              </DialogDescription>
            </DialogHeader>
            <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
              <ArtifactBrowser projectId={project.id} refreshSignal={refreshSignal} />
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <div className="min-h-0 min-w-0 flex-1">
        <VideoPreview project={project} videoRef={videoRef} />
      </div>
      <div className="h-[148px] shrink-0 border-t border-border">
        <CommentaryTimeline
          projectId={project.id}
          videoRef={videoRef}
          view={view}
          runStatus={runStatus}
          audio={audio}
        />
      </div>
    </div>
  );
}
