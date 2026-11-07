import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge.jsx";
import { Button } from "@/components/ui/button.jsx";
import { Spinner } from "@/components/ui/spinner.jsx";
import { useWorkspaceSession } from "@/lib/workspace-sessions.js";
import { formatActivityDuration, summarizeActivity } from "@/lib/api-activity-view.js";
import { formatClockTime } from "@/lib/format.js";

export const PURPOSE_LABELS = {
  vision: "Vision",
  "vision-adaptive": "Adaptive vision",
  "vision-batch": "HIGH batch",
  commentary: "Commentary",
  script: "Script",
  tts: "Spoken audio",
  "verify-connection": "Connection check",
  "verify-vision": "Image verification",
  "verify-tts": "TTS verification",
  "voice-preview": "Voice preview",
  "list-models": "Model discovery",
};

export function purposeLabel(purpose) {
  return PURPOSE_LABELS[purpose] ?? purpose;
}

const STATUS_DOT = {
  started: "bg-primary",
  succeeded: "bg-success",
  failed: "bg-destructive",
  cancelled: "bg-warning",
  interrupted: "bg-warning",
};

const STATUS_LABEL = {
  started: "Running",
  succeeded: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

function StatusDot({ status }) {
  return (
    <span
      aria-hidden
      className={`size-1.5 shrink-0 rounded-full ${STATUS_DOT[status] ?? "bg-muted-foreground"} ${status === "started" ? "motion-safe:animate-pulse" : ""}`}
    />
  );
}

function SummaryHeader({ summary }) {
  const avg = summary.timedRequests > 0
    ? formatActivityDuration(summary.totalDurationMs / summary.timedRequests)
    : null;
  const tokens = summary.hasTokens
    ? `${summary.inputTokens + summary.outputTokens} tokens`
    : null;
  return (
    <dl className="flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1">
      <div className="flex items-baseline gap-1.5">
        <dt className="text-[11px] text-muted-foreground">Requests</dt>
        <dd className="font-mono text-[12px] tabular-nums text-foreground">{summary.total}</dd>
      </div>
      <div className="flex items-baseline gap-1.5">
        <dt className="text-[11px] text-muted-foreground">Succeeded</dt>
        <dd className="font-mono text-[12px] tabular-nums text-foreground">{summary.succeeded}</dd>
      </div>
      <div className="flex items-baseline gap-1.5">
        <dt className="text-[11px] text-muted-foreground">Failed</dt>
        <dd className={`font-mono text-[12px] tabular-nums ${summary.failed > 0 ? "text-destructive" : "text-foreground"}`}>
          {summary.failed}
        </dd>
      </div>
      {avg ? (
        <div className="flex items-baseline gap-1.5">
          <dt className="text-[11px] text-muted-foreground">Avg latency</dt>
          <dd className="font-mono text-[12px] tabular-nums text-foreground">{avg}</dd>
        </div>
      ) : null}
      {tokens ? (
        <div className="flex items-baseline gap-1.5">
          <dt className="text-[11px] text-muted-foreground">Tokens</dt>
          <dd className="font-mono text-[12px] tabular-nums text-foreground">{tokens}</dd>
        </div>
      ) : null}
    </dl>
  );
}

function RecordDetails({ record }) {
  const rows = [];
  if (record.model) rows.push(["Model", record.model]);
  if (record.runId) rows.push(["Run", record.runId]);
  rows.push(["Request", record.id]);
  if (record.frameCount > 0) rows.push(["Frames", String(record.frameCount)]);
  if (typeof record.httpStatus === "number") rows.push(["HTTP", String(record.httpStatus)]);
  if (typeof record.inputTokens === "number" || typeof record.outputTokens === "number") {
    rows.push(["Tokens", `${record.inputTokens ?? 0} in · ${record.outputTokens ?? 0} out`]);
  }
  if (record.errorCode) rows.push(["Error code", record.errorCode]);
  for (const [key, value] of Object.entries(record.metadata ?? {})) {
    rows.push([key, value]);
  }
  return (
    <div className="min-w-0 px-1 pt-1.5">
      {record.errorMessage ? (
        <p className="min-w-0 text-[11px] leading-relaxed text-destructive [overflow-wrap:anywhere]">
          {record.errorMessage}
        </p>
      ) : null}
      <dl className="mt-1 flex min-w-0 flex-col gap-1">
        {rows.map(([label, value]) => (
          <div key={label} className="flex min-w-0 items-baseline justify-between gap-3">
            <dt className="shrink-0 text-[11px] text-muted-foreground">{label}</dt>
            <dd className="min-w-0 truncate font-mono text-[11px] text-foreground" title={value}>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function RecordRow({ record }) {
  const duration = formatActivityDuration(record.durationMs);
  const meta = [];
  if (duration) meta.push(duration);
  if (typeof record.httpStatus === "number") meta.push(`HTTP ${record.httpStatus}`);
  if (typeof record.inputTokens === "number" || typeof record.outputTokens === "number") {
    meta.push(`${(record.inputTokens ?? 0) + (record.outputTokens ?? 0)} tok`);
  }
  return (
    <li className="min-w-0 border-b border-border/60 py-1.5 last:border-b-0">
      <details className="group min-w-0">
        <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
          <StatusDot status={record.status} />
          <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">
            {purposeLabel(record.purpose)}
            <span className="text-muted-foreground"> · {record.provider}</span>
          </span>
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
            {formatClockTime(record.startedAt ?? record.completedAt)}
          </span>
          {meta.length > 0 ? (
            <span className="hidden shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground min-[420px]:inline">
              {meta.join(" · ")}
            </span>
          ) : null}
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {STATUS_LABEL[record.status] ?? record.status}
          </span>
        </summary>
        <RecordDetails record={record} />
      </details>
    </li>
  );
}

/**
 * Live API activity monitor. Project records stream from the session
 * (same source the pipeline summarizes); the settings scope
 * (credential checks, voice previews) loads on demand.
 */
export default function ApiActivityPanel({ projectId }) {
  const session = useWorkspaceSession(projectId);
  const liveRecords = useMemo(
    () => (Array.isArray(session?.apiActivity) ? session.apiActivity : []),
    [session],
  );
  const [scope, setScope] = useState("project");
  const [settingsRecords, setSettingsRecords] = useState(null);
  const [settingsError, setSettingsError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadSettings = useCallback(async () => {
    if (typeof window.api?.getApiActivity !== "function") {
      setSettingsError("Activity history is unavailable in this build.");
      return;
    }
    setRefreshing(true);
    setSettingsError(null);
    try {
      const res = await window.api.getApiActivity(null);
      if (res?.ok === true && Array.isArray(res.records)) {
        setSettingsRecords(res.records);
      } else {
        setSettingsError(res?.error ?? "Could not load settings activity.");
      }
    } catch (err) {
      setSettingsError(err?.message ?? "Could not load settings activity.");
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (scope === "settings" && settingsRecords === null && settingsError === null) {
      void loadSettings();
    }
  }, [scope, settingsRecords, settingsError, loadSettings]);

  const records = scope === "settings" ? (settingsRecords ?? []) : liveRecords;
  const ordered = useMemo(() => [...records].reverse(), [records]);
  const summary = useMemo(() => summarizeActivity(records), [records]);

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1" role="group" aria-label="Activity scope">
          <Button
            type="button"
            size="sm"
            variant={scope === "project" ? "secondary" : "ghost"}
            onClick={() => setScope("project")}
          >
            This project
          </Button>
          <Button
            type="button"
            size="sm"
            variant={scope === "settings" ? "secondary" : "ghost"}
            onClick={() => setScope("settings")}
          >
            Settings
          </Button>
        </div>
        {scope === "settings" ? (
          <Button type="button" size="sm" variant="ghost" disabled={refreshing} onClick={loadSettings} title="Reload settings activity">
            {refreshing ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
            Refresh
          </Button>
        ) : (
          <Badge variant="outline">Live</Badge>
        )}
      </div>

      <SummaryHeader summary={summary} />

      {scope === "project" && session?.hydration !== "ready" ? (
        <p role="status" className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <Spinner />
          Restoring activity history…
        </p>
      ) : scope === "settings" && settingsRecords === null ? (
        settingsError ? (
          <p role="alert" className="text-[12px] text-destructive">{settingsError}</p>
        ) : (
          <p role="status" className="flex items-center gap-2 text-[12px] text-muted-foreground">
            <Spinner />
            Loading settings activity…
          </p>
        )
      ) : ordered.length === 0 ? (
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          {scope === "settings"
            ? "No credential checks, model discoveries, or voice previews yet."
            : "No API requests yet. Vision, commentary, script, and spoken-audio requests appear here as they run."}
        </p>
      ) : (
        <ul aria-live="polite" className="min-w-0">
          {ordered.map((record) => (
            <RecordRow key={record.id} record={record} />
          ))}
        </ul>
      )}
    </div>
  );
}
