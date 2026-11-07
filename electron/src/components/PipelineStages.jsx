import { useMemo } from "react";
import { ScrollFade } from "@animate-ui/react/primitives/effects/scroll-fade";
import { Badge } from "@/components/ui/badge.jsx";
import { Spinner } from "@/components/ui/spinner.jsx";
import { derivePipelineStages, formatActivityDuration } from "@/lib/api-activity-view.js";

const STAGE_DOT = {
  waiting: "bg-muted-foreground",
  running: "bg-primary",
  completed: "bg-success",
  failed: "bg-destructive",
  skipped: "bg-muted-foreground",
  cancelled: "bg-warning",
  interrupted: "bg-warning",
};

function SpeedBadge({ speed }) {
  // Monochrome hierarchy only: emphasis follows sampling density.
  const variant = speed === "HIGH" ? "default" : speed === "NORMAL" ? "secondary" : "outline";
  return <Badge variant={variant}>{speed}</Badge>;
}

function SamplingDetails({ adaptive, runStatus }) {
  const samples = adaptive?.samples ?? [];
  const waiting = runStatus === "processing" && samples.length === 0;
  if (waiting) {
    return (
      <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <Spinner />
        Waiting for the first sampling decision…
      </p>
    );
  }
  if (samples.length === 0) {
    return null;
  }
  return (
    <div className="min-w-0">
      <p className="font-mono text-[10px] tabular-nums text-muted-foreground">
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
  );
}

function DetailRows({ detail }) {
  const rows = [];
  if (detail.requests > 0) {
    rows.push(["API requests", String(detail.requests)]);
    rows.push(["Succeeded", String(detail.succeeded)]);
    if (detail.failed > 0) rows.push(["Failed", String(detail.failed)]);
  }
  if (detail.batches > 0) {
    rows.push(["HIGH batches", String(detail.batches)]);
  }
  const span = formatActivityDuration(detail.spanMs);
  if (span) rows.push(["Request span", span]);
  if (rows.length === 0 && detail.failures.length === 0) {
    return null;
  }
  return (
    <div className="min-w-0">
      {rows.length > 0 ? (
        <dl className="flex min-w-0 flex-col gap-1">
          {rows.map(([label, value]) => (
            <div key={label} className="flex min-w-0 items-baseline justify-between gap-3">
              <dt className="shrink-0 text-[11px] text-muted-foreground">{label}</dt>
              <dd className="font-mono text-[11px] tabular-nums text-foreground">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {detail.failures.map((message) => (
        <p key={message} className="mt-1 min-w-0 text-[11px] leading-relaxed text-destructive [overflow-wrap:anywhere]">
          {message}
        </p>
      ))}
    </div>
  );
}

function StageRow({ view, adaptive, runStatus }) {
  const running = view.status === "running";
  return (
    <li className={`min-w-0 rounded-sm ${running ? "bg-muted/40" : ""}`}>
      <details className="group min-w-0 px-1.5 py-1">
        <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <span
            aria-hidden
            className={`size-1.5 shrink-0 rounded-full ${STAGE_DOT[view.status] ?? "bg-muted-foreground"} ${running ? "motion-safe:animate-pulse" : ""}`}
          />
          <span className={`min-w-0 flex-1 truncate text-[12px] ${running ? "font-medium text-foreground" : "text-foreground"}`}>
            {view.label}
            {view.summary ? (
              <span className="font-normal text-muted-foreground"> · {view.summary}</span>
            ) : null}
          </span>
          <span className="shrink-0 text-[11px] text-muted-foreground">{view.statusLabel}</span>
        </summary>
        <div className="flex min-w-0 flex-col gap-2 px-1 pb-1 pt-2">
          {view.reason && view.status !== "skipped" ? (
            <p className="min-w-0 text-[11px] leading-relaxed text-muted-foreground">{view.reason}</p>
          ) : null}
          {view.detail ? <DetailRows detail={view.detail} /> : null}
          {view.key === "adaptive_vision" ? (
            <SamplingDetails adaptive={adaptive} runStatus={runStatus} />
          ) : null}
        </div>
      </details>
    </li>
  );
}

/**
 * Live processing pipeline: one row per observed stage, with the same
 * API activity records Diagnostics shows folded into per-stage counts.
 * Nothing is invented — rows come only from reported stages, the
 * current stage, and the TTS inference in the deriver.
 */
export default function PipelineStages({ run, apiActivity, ttsRun }) {
  const views = useMemo(
    () => derivePipelineStages({ run, apiActivity, ttsRun }),
    [run, apiActivity, ttsRun],
  );
  if (views.length === 0) {
    return null;
  }
  return (
    <section aria-label="Processing pipeline" className="min-w-0">
      <h2 className="text-[11px] font-medium text-muted-foreground">Pipeline</h2>
      <ul aria-live="polite" className="mt-1 flex min-w-0 flex-col">
        {views.map((view) => (
          <StageRow key={view.key} view={view} adaptive={run.adaptive} runStatus={run.status} />
        ))}
      </ul>
    </section>
  );
}
