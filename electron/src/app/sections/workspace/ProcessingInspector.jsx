import { useState } from "react";
import { Cpu, FolderOpen, Play, RotateCcw, ScrollText, SlidersHorizontal, Sparkles } from "lucide-react";
import { AutoHeight } from "@animate-ui/react/primitives/effects/auto-height";
import { ScrollFade } from "@animate-ui/react/primitives/effects/scroll-fade";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.jsx";
import { Badge } from "@/components/ui/badge.jsx";
import { Button } from "@/components/ui/button.jsx";
import { Separator } from "@/components/ui/separator.jsx";
import { Spinner } from "@/components/ui/spinner.jsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.jsx";
import AILoadingState from "@/components/kokonutui/ai-loading.jsx";
import AITextLoading from "@/components/kokonutui/ai-text-loading.jsx";
import RunPanel from "@/components/RunPanel.jsx";
import StatusIndicator from "@/primitives/StatusIndicator.jsx";
import ProjectConfiguration from "./ProjectConfiguration.jsx";
import ScriptPanel from "./ScriptPanel.jsx";
import { extensionOf, fileNameOf, formatBytes } from "@/lib/format.js";
import { ADAPTIVE_HARD_MAX_FRAMES, isValidAdaptiveMaxFrames } from "@/lib/run-options.js";
import { EASING, MOTION } from "@/lib/tokens.js";
import { skipReasonLabel, stageDetailText, stageLabel } from "@/lib/worker-view.js";

const RUN_STATUS = {
  idle: { key: "idle", label: "Idle" },
  processing: { key: "processing", label: "Processing" },
  completed: { key: "done", label: "Completed" },
  failed: { key: "error", label: "Failed" },
  cancelled: { key: "cancelled", label: "Cancelled" },
  stopped: { key: "stopped", label: "Stopped" },
};

const PROJECT_STATUS = {
  idle: "Idle",
  processing: "Processing",
  done: "Completed",
  error: "Failed",
  cancelled: "Cancelled",
  stopped: "Stopped",
  interrupted: "Interrupted",
};

function SectionHeading({ children, id }) {
  return <h2 id={id} className="text-[11px] font-medium text-muted-foreground">{children}</h2>;
}

function SpeedBadge({ speed }) {
  // Monochrome hierarchy only: emphasis follows sampling density.
  const variant = speed === "HIGH" ? "default" : speed === "NORMAL" ? "secondary" : "outline";
  return <Badge variant={variant}>{speed}</Badge>;
}

/**
 * Derive loading-state steps from observed run state only: finished
 * stages plus the current one. Nothing is invented — planned-but-unseen
 * stages (conditional script/tts) never appear, and failures attach to
 * the stage the worker named (or, when it named none, to the last
 * observed step, with the true stage in the error panel below).
 */
function loadingSteps(run) {
  const seen = Object.keys(run.stages);
  const ordered = [
    ...seen,
    ...(run.currentStage && !seen.includes(run.currentStage) ? [run.currentStage] : []),
  ];
  const steps = ordered.map((stage) => {
    const info = run.stages[stage];
    let status = "pending";
    let label = stageLabel(stage);
    if (info?.status === "done") {
      status = "done";
    } else if (info?.status === "skipped") {
      status = "skipped";
      const reason = skipReasonLabel(info?.detail?.reason);
      label = reason ? `${label} · ${reason}` : `${label} · Skipped`;
    } else if (run.status === "failed" && run.error?.stage === stage) {
      status = "error";
    } else if (stage === run.currentStage) {
      status = "running";
    }
    const detail = [];
    if (stage === "adaptive_vision" && run.adaptive) {
      detail.push(
        `${run.adaptive.observations ?? 0} observations · ${run.adaptive.requests ?? 0} requests`,
      );
    } else {
      const text = stageDetailText(info?.detail);
      if (text) {
        detail.push(text);
      }
    }
    return { id: stage, label, status, detail };
  });
  if (run.status === "failed" && steps.length > 0 && !steps.some((step) => step.status === "error" || step.status === "running")) {
    // The worker died without staging the error (spawn/worker/exit
    // failures): mark the last observed step so the list reads terminal
    // instead of idle. The error panel below names the true stage.
    steps[steps.length - 1] = { ...steps[steps.length - 1], status: "error" };
  }
  return steps;
}

function StageProgress({ run }) {
  const steps = loadingSteps(run);
  if (steps.length === 0) {
    return null;
  }
  return (
    <section aria-label="Processing stages" className="min-w-0">
      <AILoadingState steps={steps} className="items-start justify-start" />
    </section>
  );
}

function SamplingActivity({ adaptive, runStatus }) {
  const samples = adaptive?.samples ?? [];
  const waiting = runStatus === "processing" && samples.length === 0;
  const terminal = runStatus === "completed" || runStatus === "failed" || runStatus === "cancelled" || runStatus === "stopped";
  if (samples.length === 0 && !waiting) {
    if (terminal) {
      return null;
    }
    return (
      <section aria-label="Sampling activity" className="min-w-0">
        <SectionHeading>Sampling activity</SectionHeading>
        <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
          Sampling decisions will appear here once processing begins.
        </p>
      </section>
    );
  }
  return (
    <section aria-label="Sampling activity" className="min-w-0">
      <SectionHeading>Sampling activity</SectionHeading>
      {samples.length === 0 ? (
        <p className="mt-1 flex items-center gap-2 text-[12px] text-muted-foreground">
          <Spinner />
          Waiting for the first sampling decision…
        </p>
      ) : (
        <div className="mt-1 min-w-0 rounded-sm border border-border bg-background px-2.5 py-2">
          <p aria-live="polite" className="font-mono text-[10px] tabular-nums text-muted-foreground">
            {adaptive.observations ?? samples.length} observations · {adaptive.requests ?? samples.length} requests
          </p>
          <ScrollFade asChild orientation="vertical" size={28}>
            <ul className="mt-1.5 flex max-h-44 min-w-0 flex-col gap-1 overflow-y-auto">
              {samples.map((sample, index) => (
                <li key={`${sample.timestamp}-${index}`} className="flex min-w-0 items-center gap-2 text-[11px]">
                  <span className="shrink-0 font-mono tabular-nums text-muted-foreground">{sample.timestamp}s</span>
                  <SpeedBadge speed={sample.speed} />
                  <span className="min-w-0 flex-1 truncate text-foreground" title={sample.reason || undefined}>
                    {sample.next === null || sample.next === undefined ? "run ended" : `next ${sample.next}s`}
                    {sample.reason ? ` · ${sample.reason}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </ScrollFade>
        </div>
      )}
    </section>
  );
}

function ReadyState({ adaptiveMaxFrames, ttsRun, visionConfigured, visionChecked, onShowConfigure }) {
  const limitText = adaptiveMaxFrames === null || adaptiveMaxFrames === undefined || adaptiveMaxFrames === ""
    ? "Unlimited"
    : `Up to ${adaptiveMaxFrames}`;
  return (
    <section aria-label="Ready to process" className="flex min-w-0 flex-col gap-2">
      <h2 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">Process this video</h2>
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        Adaptive sampling watches the full video, requesting vision analysis where the footage
        changes, then rebuilds match state, detects events, and writes commentary.
      </p>
      <dl className="flex min-w-0 flex-col gap-1.5">
        <div className="flex min-w-0 items-baseline justify-between gap-3">
          <dt className="shrink-0 text-[11px] text-muted-foreground">Analysis mode</dt>
          <dd className="min-w-0 truncate text-right text-[11px] text-foreground">Adaptive sampling</dd>
        </div>
        <div className="flex min-w-0 items-baseline justify-between gap-3">
          <dt className="shrink-0 text-[11px] text-muted-foreground">Vision requests</dt>
          <dd className="min-w-0 truncate text-right font-mono text-[11px] tabular-nums text-foreground">{limitText}</dd>
        </div>
        <div className="flex min-w-0 items-baseline justify-between gap-3">
          <dt className="shrink-0 text-[11px] text-muted-foreground">Spoken audio</dt>
          <dd className="min-w-0 truncate text-right text-[11px] text-foreground">Automatic</dd>
        </div>
      </dl>
      {visionChecked && !visionConfigured ? (
        <Alert>
          <AlertTitle>Configuration incomplete</AlertTitle>
          <AlertDescription className="flex min-w-0 flex-col gap-2">
            <span>Paid analysis needs a verified API configuration. Frame extraction never runs without one.</span>
            <span>
              <Button type="button" size="sm" variant="outline" onClick={onShowConfigure}>
                Open Configure
              </Button>
            </span>
          </AlertDescription>
        </Alert>
      ) : null}
      {!visionChecked ? (
        <p role="status" className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Spinner />
          Checking AI readiness…
        </p>
      ) : null}
      <div>
        <Button type="button" size="sm" variant="ghost" onClick={onShowConfigure} className="px-0">
          Advanced settings
        </Button>
      </div>
    </section>
  );
}

function Diagnostics({ workerLogs }) {
  if (!Array.isArray(workerLogs) || workerLogs.length === 0) {
    return null;
  }
  return (
    <details className="group min-w-0">
      <summary className="cursor-pointer list-none rounded-sm text-[11px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="mr-1 inline-block transition-transform duration-150 group-open:rotate-90">▸</span>
        Worker diagnostics ({workerLogs.length})
      </summary>
      <pre className="mt-1.5 max-h-32 min-w-0 overflow-auto rounded-sm border border-border bg-background p-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
        {workerLogs.slice(-20).join("\n")}
      </pre>
    </details>
  );
}

function ProcessingContent({ project, run, canStart, starting, cancelling, cancelError, stopping, stopError, runIsAdaptive, adaptiveMaxFrames, ttsRun, visionConfigured, visionChecked, onStart, onCancel, onStop, onShowConfigure }) {
  const interrupted = project.processingStatus === "interrupted" && run.status === "idle";
  const stoppingNow = stopping && run.status === "processing";
  const cancellingNow = cancelling && run.status === "processing";
  const displayStatus = stoppingNow
    ? { key: "processing", label: "Stopping" }
    : cancellingNow
      ? { key: "processing", label: "Cancelling" }
      : starting && run.status === "idle"
        ? { key: "processing", label: "Starting" }
        : interrupted
          ? { key: "interrupted", label: "Interrupted" }
          : RUN_STATUS[run.status] ?? { key: "idle", label: "Idle" };
  const showStages = run.status === "processing" || run.status === "failed" || run.status === "completed";
  const startLabel = run.status === "failed" ? "Retry processing" : run.status === "idle" ? "Process video" : "Process again";
  const startIcon = run.status === "failed" ? <RotateCcw data-icon="inline-start" /> : <Play data-icon="inline-start" />;

  return (
    <div className="flex min-w-0 flex-col gap-3 p-3">
      <AutoHeight
        deps={[run.status, run.currentStage]}
        transition={{ duration: MOTION.standard, ease: EASING.entrance }}
        className="flex min-w-0 flex-col gap-2"
      >
        <section aria-label="Current processing status" className="flex min-w-0 flex-col gap-2">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <SectionHeading>Run status</SectionHeading>
            <StatusIndicator status={displayStatus.key} label={displayStatus.label} />
          </div>
          {run.status === "processing" && run.currentStage ? (
            <div className="min-w-0 rounded-sm border border-border bg-background px-2.5 py-2">
              <p className="text-[10px] text-subtle">Current stage</p>
              <AITextLoading
                texts={[stageLabel(run.currentStage)]}
                label={`Current stage: ${stageLabel(run.currentStage)}`}
                className="mt-0.5 w-full justify-start gap-0 overflow-hidden text-left text-[12px] font-medium text-foreground"
              />
              {run.totalStages > 0 ? (
                <p className="mt-1 font-mono text-[10px] tabular-nums text-muted-foreground">
                  {run.completedCount} of {run.totalStages} stages complete
                </p>
              ) : null}
            </div>
          ) : null}
        </section>

        {interrupted ? (
          <Alert>
            <AlertTitle>Previous run was interrupted</AlertTitle>
            <AlertDescription className="min-w-0 [overflow-wrap:anywhere]">
              The application closed while this project was processing. Start a new run when ready.
            </AlertDescription>
          </Alert>
        ) : null}
      </AutoHeight>

      {run.status === "idle" ? (
        <>
          <Separator />
          <ReadyState
            adaptiveMaxFrames={adaptiveMaxFrames}
            ttsRun={ttsRun}
            visionConfigured={visionConfigured}
            visionChecked={visionChecked}
            onShowConfigure={onShowConfigure}
          />
        </>
      ) : null}

      {ttsRun && ttsRun.enabled === false && typeof ttsRun.reason === "string" && ttsRun.reason !== "" ? (
        <p role="status" className="rounded-sm border border-border bg-background px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
          Spoken audio is off for this run: {ttsRun.reason}{" "}
          <button
            type="button"
            onClick={onShowConfigure}
            className="rounded-sm text-foreground underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Open Configure
          </button>
        </p>
      ) : null}

      <Separator />
      <div className="flex min-w-0 flex-col gap-2">
        {run.status === "processing" ? (
          runIsAdaptive ? (
            <>
              <Button type="button" size="sm" disabled={stopping} onClick={onStop} className="w-full">
                {stopping ? (
                  <>
                    <Spinner data-icon="inline-start" />
                    Stop requested…
                  </>
                ) : (
                  "Request stop"
                )}
              </Button>
              {stopping ? (
                <p role="status" className="text-center text-[10px] text-muted-foreground">Stopping after the current request…</p>
              ) : null}
              <Button type="button" size="sm" variant="outline" disabled={cancelling} onClick={onCancel} className="w-full">
                {cancelling ? (
                  <>
                    <Spinner data-icon="inline-start" />
                    Cancelling…
                  </>
                ) : (
                  "Force cancel"
                )}
              </Button>
            </>
          ) : (
            <Button type="button" size="sm" variant="outline" disabled={cancelling} onClick={onCancel} className="w-full">
              {cancelling ? (
                <>
                  <Spinner data-icon="inline-start" />
                  Cancelling…
                </>
              ) : (
                "Cancel processing"
              )}
            </Button>
          )
        ) : (
          <Button type="button" size="sm" disabled={!canStart} onClick={onStart} className="w-full">
            {starting ? (
              <>
                <Spinner data-icon="inline-start" />
                Starting…
              </>
            ) : (
              <>
                {startIcon}
                {startLabel}
              </>
            )}
          </Button>
        )}
        {run.status === "processing" && cancelling ? (
          <p role="status" className="text-center text-[10px] text-muted-foreground">Waiting for processing to stop…</p>
        ) : null}
        {stopError && run.status === "processing" ? (
          <Alert variant="destructive">
            <AlertTitle>Could not request stop</AlertTitle>
            <AlertDescription className="min-w-0 [overflow-wrap:anywhere]">{stopError}</AlertDescription>
          </Alert>
        ) : null}
      </div>

      {showStages ? (
        <>
          <Separator />
          <StageProgress run={run} />
        </>
      ) : null}

      <Separator />
      <section aria-label="Run outcome" className="min-w-0">
        <RunPanel
          run={run}
          cancelling={cancelling}
          cancelError={cancelError}
          showActions={false}
          showStatus={false}
          showStages={run.status === "stopped" || run.status === "cancelled"}
          className="gap-2"
        />
      </section>

      {runIsAdaptive || run.adaptive || run.status === "idle" ? (
        <>
          <Separator />
          <SamplingActivity adaptive={run.adaptive} runStatus={run.status} />
        </>
      ) : null}

      <Separator />
      <Diagnostics workerLogs={run.workerLogs} />
    </div>
  );
}

function GroupTitle({ children }) {
  return (
    <p className="pt-2 text-[10px] font-medium uppercase tracking-[0.12em] text-subtle">
      {children}
    </p>
  );
}

function ConfigurationContent({ projectId, visionConfigured, visionChecked, canStart, adaptiveMaxFrames, setAdaptiveMaxFrames, onReadinessChange, onNavigate }) {
  const limitValid = isValidAdaptiveMaxFrames(adaptiveMaxFrames);
  return (
    <div className="flex min-w-0 flex-col gap-1 p-3">
      <ProjectConfiguration projectId={projectId} onReadinessChange={onReadinessChange} onNavigate={onNavigate} />
      <Separator />
      <GroupTitle>Processing</GroupTitle>
      <section className="flex min-w-0 flex-col gap-2" aria-labelledby="processing-mode-title">
        <SectionHeading id="processing-mode-title">Processing mode</SectionHeading>
        <div className="flex min-w-0 items-center gap-2 rounded-sm border border-border bg-muted/40 px-2.5 py-2">
          <Sparkles data-icon="inline-start" className="text-muted-foreground" />
          <div className="min-w-0">
            <p className="text-[12px] font-medium text-foreground">Adaptive sampling</p>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Samples where the footage changes fastest: each frame costs one paid vision request, and the model schedules the next capture.
            </p>
          </div>
        </div>
      </section>

      <Separator />
      <section className="flex min-w-0 flex-col gap-2" aria-labelledby="adaptive-limit-title">
        <SectionHeading id="adaptive-limit-title">Advanced · Vision requests</SectionHeading>
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor="adaptive-max-frames" className="text-[12px] text-foreground">
            Maximum vision requests <span className="text-muted-foreground">(optional)</span>
          </label>
          <input
            id="adaptive-max-frames"
            type="number"
            min={1}
            max={ADAPTIVE_HARD_MAX_FRAMES}
            value={adaptiveMaxFrames ?? ""}
            placeholder="Unlimited"
            disabled={!canStart}
            aria-invalid={!limitValid}
            onChange={(event) => {
              const raw = event.target.value;
              setAdaptiveMaxFrames(raw === "" ? null : Number(raw));
            }}
            className="h-8 rounded-sm border border-border bg-background px-2 font-mono text-[12px] tabular-nums text-foreground outline-none placeholder:text-subtle focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50 aria-[invalid=true]:border-destructive"
          />
          {!limitValid ? (
            <p role="alert" className="text-[11px] leading-relaxed text-destructive">
              Enter 1 or more, or clear the field for unlimited.
            </p>
          ) : (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Each sampled frame makes at most one paid vision request. Empty means unlimited:
              sampling runs to video end — the model still skips uneventful stretches, so this
              is not one request per decoded frame. Explicit bounds hold to {ADAPTIVE_HARD_MAX_FRAMES}.
            </p>
          )}
        </div>
      </section>

      <Separator />

      <section className="flex min-w-0 flex-col gap-2" aria-labelledby="commentary-audio-title">
        <SectionHeading id="commentary-audio-title">Commentary audio</SectionHeading>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Commentary text is always generated live as the video is analyzed.
          Spoken audio generates automatically with every run, using this
          project&apos;s voice. Runs continue with text commentary when no
          verified TTS credential is configured.
        </p>
        {onNavigate ? (
          <button
            type="button"
            onClick={() => onNavigate("tts-studio")}
            className="self-start rounded-sm text-[11px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Open voice providers
          </button>
        ) : null}
      </section>

      <Separator />

      <section className="flex min-w-0 flex-col gap-2" aria-labelledby="provider-status-title">
        <h2 id="provider-status-title" className="text-[11px] font-medium text-muted-foreground">AI availability</h2>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[12px] text-foreground">AI readiness</span>
          <Badge variant={visionConfigured ? "secondary" : "outline"}>
            {visionChecked ? (visionConfigured ? "Configured" : "Not configured") : "Checking"}
          </Badge>
        </div>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {visionConfigured
            ? "AI analysis is available for this workspace."
            : visionChecked
              ? `Adaptive sampling is disabled until a verified API configuration is ready. Choose one in the Project configuration above.`
              : "Checking whether AI analysis is available…"}
        </p>
      </section>
    </div>
  );
}

function ProjectContent({ project }) {
  const sourceName = fileNameOf(project.sourceVideo.path);
  const extension = extensionOf(project.sourceVideo.path);
  const projectStatus = PROJECT_STATUS[project.processingStatus] ?? project.processingStatus;
  const rows = [
    ["Format", extension ? `.${extension}` : "Unavailable", true],
    ["File size", formatBytes(project.sourceVideo.sizeBytes), true],
    ["Processing status", projectStatus, false],
  ];

  return (
    <div className="flex min-w-0 flex-col gap-3 p-3">
      <section className="flex min-w-0 items-center gap-2" aria-label="Project name">
        <FolderOpen className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h2 className="min-w-0 truncate text-[13px] font-medium text-foreground" title={project.name}>{project.name}</h2>
      </section>
      <Separator />
      <dl className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <dt className="text-[10px] text-subtle">Source video</dt>
          <dd className="truncate text-[11px] text-foreground" title={sourceName}>{sourceName || "Unavailable"}</dd>
        </div>
        {rows.map(([label, value, monospace]) => (
          <div key={label} className="flex min-w-0 items-baseline justify-between gap-3">
            <dt className="shrink-0 text-[11px] text-muted-foreground">{label}</dt>
            <dd className={`min-w-0 truncate text-right text-[11px] text-foreground ${monospace ? "font-mono tabular-nums" : ""}`} title={value}>
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-[10px] leading-relaxed text-muted-foreground">Processing output stays inside this project.</p>
    </div>
  );
}

export default function ProcessingInspector({
  project,
  run,
  runMode,
  setRunMode,
  visionConfigured,
  visionMissing,
  visionChecked,
  canStart,
  starting,
  cancelling,
  cancelError,
  stopping,
  stopError,
  runIsAdaptive,
  adaptiveMaxFrames,
  setAdaptiveMaxFrames,
  ttsRun,
  script = null,
  runStatus = "idle",
  audio = null,
  onStart,
  onCancel,
  onStop,
  onReadinessChange,
  onNavigate,
}) {
  const [tab, setTab] = useState("processing");
  return (
    <Tabs value={tab} onValueChange={setTab} className="flex h-full min-h-0 min-w-0 flex-col gap-0 overflow-hidden bg-surface">
      <TabsList variant="line" aria-label="Inspector sections" className="h-10 w-full shrink-0 gap-1 rounded-none border-b border-border px-1.5 py-0">
        <TabsTrigger value="processing" title="Processing" className="h-9 min-w-0 flex-1 gap-1 rounded-sm px-1 text-[11px]">
          <Cpu className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate @max-[320px]:hidden">Processing</span>
        </TabsTrigger>
        <TabsTrigger value="script" title="Script" className="h-9 min-w-0 flex-1 gap-1 rounded-sm px-1 text-[11px]">
          <ScrollText className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate @max-[320px]:hidden">Script</span>
        </TabsTrigger>
        <TabsTrigger value="configuration" title="Configure" className="h-9 min-w-0 flex-1 gap-1 rounded-sm px-1 text-[11px]">
          <SlidersHorizontal className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate @max-[320px]:hidden">Configure</span>
        </TabsTrigger>
        <TabsTrigger value="project" title="Project" className="h-9 min-w-0 flex-1 gap-1 rounded-sm px-1 text-[11px]">
          <FolderOpen className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate @max-[320px]:hidden">Project</span>
        </TabsTrigger>
      </TabsList>

      <TabsContent value="processing" className="m-0 min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden outline-none">
        <ProcessingContent
          project={project}
          run={run}
          canStart={canStart}
          starting={starting}
          cancelling={cancelling}
          cancelError={cancelError}
          stopping={stopping}
          stopError={stopError}
          runIsAdaptive={runIsAdaptive}
          adaptiveMaxFrames={adaptiveMaxFrames}
          ttsRun={ttsRun}
          visionConfigured={visionConfigured}
          visionChecked={visionChecked}
          onStart={onStart}
          onCancel={onCancel}
          onStop={onStop}
          onShowConfigure={() => setTab("configuration")}
        />
      </TabsContent>
      <TabsContent
        value="script"
        forceMount
        className={`m-0 min-h-0 min-w-0 flex-1 overflow-hidden outline-none ${tab === "script" ? "" : "hidden"}`}
      >
        <ScriptPanel projectId={project.id} script={script} runStatus={runStatus} audio={audio} />
      </TabsContent>
      <TabsContent value="configuration" className="m-0 min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden outline-none">
        <ConfigurationContent
          projectId={project.id}
          runMode={runMode}
          setRunMode={setRunMode}
          visionConfigured={visionConfigured}
          visionMissing={visionMissing}
          visionChecked={visionChecked}
          canStart={canStart}
          adaptiveMaxFrames={adaptiveMaxFrames}
          setAdaptiveMaxFrames={setAdaptiveMaxFrames}
          onReadinessChange={onReadinessChange}
          onNavigate={onNavigate}
        />
      </TabsContent>
      <TabsContent value="project" className="m-0 min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden outline-none">
        <ProjectContent project={project} />
      </TabsContent>
    </Tabs>
  );
}
