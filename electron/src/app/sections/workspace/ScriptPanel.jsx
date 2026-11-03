import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, ScrollText } from "lucide-react";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge.jsx";
import { Button } from "@/components/ui/button.jsx";
import { buildAudioRows } from "@/lib/audio-rows.js";
import { projectMediaUrl } from "@/lib/format.js";

function RowBadge({ row, superseded, live }) {
  if (superseded) {
    return <Badge variant="outline">Superseded</Badge>;
  }
  switch (row.state) {
    case "ready":
      return <Badge variant="secondary">Audio ready</Badge>;
    case "generating":
      return <Badge variant="outline">Generating</Badge>;
    case "waiting":
      return <Badge variant="outline">Waiting</Badge>;
    case "failed":
      return (
        <Badge variant="destructive" title={row.error ?? "Audio synthesis failed."}>
          Audio failed
        </Badge>
      );
    case "unavailable":
      return <Badge variant="destructive">Unavailable</Badge>;
    case "skipped":
      return <Badge variant="outline">Skipped</Badge>;
    case "no-audio":
      return <Badge variant="outline">{live ? "Waiting" : "No audio"}</Badge>;
    default:
      return <Badge variant="outline">{row.rawStatus ?? "Unknown"}</Badge>;
  }
}

function formatTimestamp(timestamp) {
  return typeof timestamp === "number" && Number.isFinite(timestamp)
    ? `${timestamp.toFixed(1)}s`
    : "—";
}

const ScriptRow = memo(function ScriptRow({
  row,
  superseded,
  live,
  loadFailed,
  previewState,
  onTogglePreview,
}) {
  const playable = row.state === "ready" && row.scope && row.name && !loadFailed && !superseded;
  const sounding = previewState === "playing";
  return (
    <li
      className={cn(
        "flex min-w-0 items-start gap-2.5 px-3 py-2.5 transition-colors duration-150",
        sounding ? "bg-secondary/60" : "hover:bg-accent/40",
      )}
    >
      <div className="min-w-0 flex-1">
        <span className="inline-block rounded-sm bg-secondary px-1.5 py-px font-mono text-[10px] tabular-nums text-secondary-foreground">
          {formatTimestamp(row.timestamp)}
        </span>
        <p
          className="mt-1 line-clamp-3 text-[13px] leading-relaxed text-foreground"
          title={row.text === "" ? row.title : `${row.text} (${row.title})`}
        >
          {row.text === "" ? row.title : row.text}
        </p>
        {row.state === "failed" && row.error ? (
          <p className="mt-0.5 truncate text-[10px] text-muted-foreground" title={row.error}>
            {row.error}
          </p>
        ) : null}
        {row.state === "unavailable" ? (
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            Success was reported but no audio file was found.
          </p>
        ) : null}
        {loadFailed ? (
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            The file could not be loaded for playback.
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1.5 pt-0.5">
        {loadFailed ? (
          <Badge variant="destructive">Unavailable</Badge>
        ) : (
          <RowBadge row={row} superseded={superseded} live={live} />
        )}
        {playable ? (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={() => onTogglePreview(row.key)}
            aria-label={
              sounding
                ? `Pause segment at ${formatTimestamp(row.timestamp)}`
                : `Play segment at ${formatTimestamp(row.timestamp)}`
            }
            title={sounding ? "Pause preview" : "Play preview"}
          >
            {sounding ? <Pause aria-hidden /> : <Play aria-hidden />}
          </Button>
        ) : null}
      </div>
    </li>
  );
});

/**
 * Readable script list for the right inspector. Rows reuse the shared
 * `buildAudioRows` join (script segments or the finalized TTS manifest
 * against discovered WAVs), so segment/TTS/file mapping matches the
 * commentary timeline exactly. One shared preview element keeps playback
 * secondary: a compact per-row toggle, never a player per segment.
 */
export default function ScriptPanel({
  projectId = null,
  script = null,
  runStatus = "idle",
  audio = null,
}) {
  const live = runStatus === "processing";
  const segments = useMemo(
    () => (Array.isArray(script?.segments) ? script.segments : []),
    [script],
  );
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
  const scriptStatusByKey = useMemo(() => {
    const map = new Map();
    for (const segment of segments) {
      if (typeof segment?.utteranceId === "string") {
        map.set(segment.utteranceId, segment.scriptStatus ?? null);
      }
    }
    return map;
  }, [segments]);

  const [broken, setBroken] = useState(() => new Set());
  const [activeKey, setActiveKey] = useState(null);
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const previewRef = useRef(null);
  const previewKeyRef = useRef(null);
  const rowsRef = useRef(view.rows);
  rowsRef.current = view.rows;
  const prevRunStatus = useRef(runStatus);

  const markBroken = useCallback((key) => {
    if (typeof key !== "string") {
      return;
    }
    setBroken((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  }, []);

  const stopPreview = useCallback(() => {
    const element = previewRef.current;
    if (element) {
      element.pause();
      element.removeAttribute("src");
    }
    previewKeyRef.current = null;
    setActiveKey(null);
    setPreviewPlaying(false);
  }, []);

  // A new run reuses segment filenames: forget unloadable files and stop
  // any preview when a run starts or the project changes.
  useEffect(() => {
    const started = prevRunStatus.current !== "processing" && runStatus === "processing";
    prevRunStatus.current = runStatus;
    if (started) {
      setBroken(new Set());
      stopPreview();
    }
  }, [runStatus, stopPreview]);
  useEffect(() => {
    setBroken(new Set());
    stopPreview();
  }, [projectId, stopPreview]);
  useEffect(() => () => {
    const element = previewRef.current;
    if (element) {
      element.pause();
      element.removeAttribute("src");
    }
    previewRef.current = null;
  }, []);

  const togglePreview = useCallback(
    (key) => {
      const row = rowsRef.current.find((entry) => entry.key === key);
      if (!row || row.state !== "ready" || !row.scope || !row.name || !projectId) {
        return;
      }
      if (typeof window === "undefined" || typeof window.Audio !== "function") {
        return;
      }
      let element = previewRef.current;
      if (!element) {
        element = new window.Audio();
        element.preload = "none";
        element.onended = () => {
          previewKeyRef.current = null;
          setActiveKey(null);
          setPreviewPlaying(false);
        };
        element.onerror = () => {
          markBroken(previewKeyRef.current);
          previewKeyRef.current = null;
          setActiveKey(null);
          setPreviewPlaying(false);
        };
        previewRef.current = element;
      }
      if (previewKeyRef.current === key && !element.paused) {
        element.pause();
        setPreviewPlaying(false);
        return;
      }
      if (previewKeyRef.current === key && element.paused && element.getAttribute("src")) {
        element
          .play()
          .then(() => setPreviewPlaying(true))
          .catch(() => {
            markBroken(key);
            previewKeyRef.current = null;
            setActiveKey(null);
            setPreviewPlaying(false);
          });
        return;
      }
      previewKeyRef.current = key;
      setActiveKey(key);
      element.src = projectMediaUrl(projectId, row.scope, row.name);
      element
        .play()
        .then(() => setPreviewPlaying(true))
        .catch(() => {
          markBroken(key);
          previewKeyRef.current = null;
          setActiveKey(null);
          setPreviewPlaying(false);
        });
    },
    [projectId, markBroken],
  );

  if (view.rows.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-1 px-4 text-center">
        <ScrollText className="size-5 text-subtle" aria-hidden />
        <p className="text-[12px] font-medium text-foreground">No script segments yet</p>
        <p className="max-w-xl text-[11px] leading-relaxed text-muted-foreground">
          {live
            ? "Commentary is being generated — lines appear here as they arrive."
            : "Start processing to watch commentary lines appear here."}
        </p>
      </div>
    );
  }

  const loadFailedCount = view.rows.filter(
    (row) => row.state === "ready" && broken.has(row.key),
  ).length;
  const ready = view.ready - loadFailedCount;
  const failed = view.failed + loadFailedCount;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <p className="shrink-0 truncate px-3 pb-1 pt-2 font-mono text-[10px] tabular-nums text-subtle">
        {view.total} segment{view.total === 1 ? "" : "s"}
        {` · ${ready} audio ready`}
        {failed > 0 ? ` · ${failed} failed` : ""}
        {view.skipped > 0 ? ` · ${view.skipped} skipped` : ""}
        {audio?.manifestInvalid ? " · manifest unreadable" : ""}
        {live ? " · updating live" : ""}
      </p>
      <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
        {view.rows.map((row) => (
          <ScriptRow
            key={row.key}
            row={row}
            superseded={scriptStatusByKey.get(row.key) === "superseded"}
            live={live}
            loadFailed={row.state === "ready" && broken.has(row.key)}
            previewState={
              row.key === activeKey ? (previewPlaying ? "playing" : "paused") : "inactive"
            }
            onTogglePreview={togglePreview}
          />
        ))}
      </ul>
    </div>
  );
}
