import { useState } from "react";
import { Cpu, FolderOpen, Play, ScrollText, SlidersHorizontal, Sparkles } from "lucide-react";
import { AutoHeight } from "@animate-ui/react/primitives/effects/auto-height";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.jsx";
import { Badge } from "@/components/ui/badge.jsx";
import { Button } from "@/components/ui/button.jsx";
import { Separator } from "@/components/ui/separator.jsx";
import { Spinner } from "@/components/ui/spinner.jsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.jsx";
import AITextLoading from "@/components/kokonutui/ai-text-loading.jsx";
import RunPanel from "@/components/RunPanel.jsx";
import StatusIndicator from "@/primitives/StatusIndicator.jsx";
import ProjectConfiguration from "./ProjectConfiguration.jsx";
import ScriptPanel from "./ScriptPanel.jsx";
import { extensionOf, fileNameOf, formatBytes } from "@/lib/format.js";
import { ADAPTIVE_DEFAULT_MAX_FRAMES, ADAPTIVE_HARD_MAX_FRAMES } from "@/lib/run-options.js";
import { EASING, MOTION } from "@/lib/tokens.js";
import { stageLabel } from "@/lib/worker-view.js";

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

function SamplingActivity({ adaptive, waiting }) {
  const samples = adaptive?.samples ?? [];
  if (samples.length === 0 && !waiting) {
    return null;
  }
  return (
    <section aria-label="Sampling activity" className="min-w-0">
      <SectionHeading>Sampling activity</SectionHeading>
      {samples.length === 0 ? (
        <p className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <Spinner />
          Waiting for the first sampling decision…
        </p>
      ) : (
        <div className="min-w-0 rounded-sm border border-border bg-background px-2.5 py-2">
          <p aria-live="polite" className="font-mono text-[10px] tabular-nums text-muted-foreground">
            {adaptive.observations ?? samples.length} observations · {adaptive.requests ?? samples.length} requests
          </p>
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
        </div>
      )}
    </section>
  );
}

function ProcessingContent({ project, run, canStart, starting, cancelling, cancelError, stopping, stopError, runIsAdaptive, onStart, onCancel, onStop }) {
  const interrupted = project.processingStatus === "interrupted" && run.status === "idle";
  const stoppingNow = stopping && run.status === "processing";
  const displayStatus = stoppingNow
    ? { key: "processing", label: "Stopping" }
    : interrupted
      ? { key: "interrupted", label: "Interrupted" }
      : RUN_STATUS[run.status] ?? { key: "idle", label: "Idle" };

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

      <Separator />
      <section aria-label="Processing stages" className="min-w-0">
        <RunPanel
          run={run}
          cancelling={cancelling}
          cancelError={cancelError}
          showActions={false}
          showStatus={false}
          className="gap-2"
        />
      </section>

      <Separator />
      {runIsAdaptive || run.adaptive ? (
        <>
          <SamplingActivity adaptive={run.adaptive} waiting={run.status === "processing"} />
          <Separator />
        </>
      ) : null}
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
                <Play data-icon="inline-start" />
                {run.status === "idle" ? "Process" : "Process again"}
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
    </div>
  );
}

function ConfigurationContent({ projectId, visionConfigured, visionChecked, canStart, adaptiveMaxFrames, setAdaptiveMaxFrames, requestTts, setRequestTts, onReadinessChange }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 p-3">
      <ProjectConfiguration projectId={projectId} onReadinessChange={onReadinessChange} />
      <Separator />
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
        <SectionHeading id="adaptive-limit-title">Adaptive sampling limit</SectionHeading>
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor="adaptive-max-frames" className="text-[12px] text-foreground">
            Maximum vision requests
          </label>
          <input
            id="adaptive-max-frames"
            type="number"
            min={1}
            max={ADAPTIVE_HARD_MAX_FRAMES}
            value={adaptiveMaxFrames}
            disabled={!canStart}
            onChange={(event) => {
              const raw = event.target.value;
              setAdaptiveMaxFrames(raw === "" ? "" : Number(raw));
            }}
            className="h-8 rounded-sm border border-border bg-background px-2 font-mono text-[12px] tabular-nums text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50"
          />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Each sampled frame makes at most one paid vision request. Default {ADAPTIVE_DEFAULT_MAX_FRAMES}; the engine caps runs at {ADAPTIVE_HARD_MAX_FRAMES}.
          </p>
        </div>
      </section>

      <Separator />

      <section className="flex min-w-0 flex-col gap-2" aria-labelledby="commentary-audio-title">
        <SectionHeading id="commentary-audio-title">Commentary audio</SectionHeading>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Commentary text is always generated live as the video is analyzed.
        </p>
        <label className="flex min-w-0 cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            checked={requestTts}
            disabled={!canStart}
            onChange={(event) => setRequestTts(event.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-primary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:opacity-50"
          />
          <span className="min-w-0">
            <span className="block text-[12px] text-foreground">Generate spoken audio</span>
            <span className="block text-[11px] leading-relaxed text-muted-foreground">
              Speak each commentary line as it arrives, using this project&apos;s TTS Studio voice.
              Needs a verified TTS credential.
            </span>
          </span>
        </label>
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
  requestTts,
  setRequestTts,
  script = null,
  runStatus = "idle",
  audio = null,
  onStart,
  onCancel,
  onStop,
  onReadinessChange,
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
          onStart={onStart}
          onCancel={onCancel}
          onStop={onStop}
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
          requestTts={requestTts}
          setRequestTts={setRequestTts}
          onReadinessChange={onReadinessChange}
        />
      </TabsContent>
      <TabsContent value="project" className="m-0 min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden outline-none">
        <ProjectContent project={project} />
      </TabsContent>
    </Tabs>
  );
}
