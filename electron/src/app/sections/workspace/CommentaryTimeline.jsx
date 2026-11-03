import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AudioLines } from "lucide-react";
import { buildAudioRows } from "@/lib/audio-rows.js";
import { buildIntervals } from "@/lib/commentary-timeline.js";
import { formatMediaTime } from "@/lib/format.js";
import {
  peekCachedBuffer,
  peaksToPath,
  WAVEFORM_PEAK_COUNT,
  WAVEFORM_VIEWBOX_HEIGHT,
  WAVEFORM_VIEWBOX_WIDTH,
} from "@/lib/waveform.js";
import useCommentaryAudio from "@/hooks/useCommentaryAudio.js";
import useCommentaryPlayback from "@/hooks/useCommentaryPlayback.js";
import useProjectAudio from "@/hooks/useProjectAudio.js";

const MIN_PX_PER_SEC = 6;
const PLACEHOLDER_PEAKS = Array.from({ length: WAVEFORM_PEAK_COUNT }, () => 0.14);
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

function tickStepFor(duration) {
  for (const step of TICK_STEPS) {
    if (duration / step <= 8) {
      return step;
    }
  }
  return 900;
}

function WaveformRegion({ interval, peaks, active }) {
  const path = peaksToPath(peaks ?? PLACEHOLDER_PEAKS);
  const decoded = Array.isArray(peaks);
  return (
    <div
      role="img"
      aria-label={
        `Commentary at ${formatMediaTime(interval.start)}` +
        `${decoded ? `, ${formatMediaTime(interval.end - interval.start)} long` : ", loading waveform"}` +
        `${active ? ", playing" : ""}`
      }
      title={interval.text === "" ? interval.title : interval.text}
      style={{ left: `${interval.leftPct}%`, width: `${interval.widthPct}%` }}
      className={`absolute inset-y-1 min-w-0 overflow-hidden rounded-sm px-px py-0.5 ${
        active ? "bg-secondary" : "bg-secondary/40"
      }`}
    >
      <svg
        viewBox={`0 0 ${WAVEFORM_VIEWBOX_WIDTH} ${WAVEFORM_VIEWBOX_HEIGHT}`}
        preserveAspectRatio="none"
        aria-hidden
        className={`block h-full w-full ${active ? "text-foreground" : "text-muted-foreground"}`}
        fill="currentColor"
      >
        <path d={path} />
      </svg>
    </div>
  );
}

function StatusTick({ leftPct, label, title, tone }) {
  return (
    <div
      role="img"
      aria-label={label}
      title={title}
      style={{ left: `${leftPct}%` }}
      className={`absolute inset-y-2 w-0.5 rounded-full ${tone}`}
    />
  );
}

export default function CommentaryTimeline({ projectId = null, videoRef = null, script = null, runStatus = "idle" }) {
  const { audioFiles, ttsEntries, manifestInvalid } = useProjectAudio(projectId, script, runStatus);
  const segments = useMemo(
    () => (Array.isArray(script?.segments) ? script.segments : []),
    [script],
  );
  const live = runStatus === "processing";
  const view = useMemo(
    () =>
      buildAudioRows({
        segments,
        files: audioFiles,
        entries: ttsEntries,
        live,
      }),
    [segments, audioFiles, ttsEntries, live],
  );
  const { meta, decodeErrors, decodeBlocked } = useCommentaryAudio(projectId, view.rows, runStatus);
  const durations = useMemo(() => {
    const map = new Map();
    for (const [key, entry] of meta) {
      map.set(key, entry.duration);
    }
    return map;
  }, [meta]);
  const intervals = useMemo(
    () => buildIntervals(view.rows, durations),
    [view.rows, durations],
  );
  const getBuffer = useCallback((key) => peekCachedBuffer(projectId, key), [projectId]);
  const playheadRef = useRef(null);
  const timeRef = useRef(null);
  const { activeKey, audioBlocked } = useCommentaryPlayback({
    videoRef,
    projectId,
    intervals,
    getBuffer,
    playheadRef,
    timeRef,
    runStatus,
  });

  const [videoDuration, setVideoDuration] = useState(null);
  useEffect(() => {
    const video = videoRef?.current;
    if (!video || typeof video.addEventListener !== "function") {
      setVideoDuration(null);
      return;
    }
    const sync = () => {
      setVideoDuration(Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null);
    };
    sync();
    video.addEventListener("loadedmetadata", sync);
    video.addEventListener("durationchange", sync);
    return () => {
      video.removeEventListener("loadedmetadata", sync);
      video.removeEventListener("durationchange", sync);
    };
  }, [projectId, videoRef]);

  const maxEnd = intervals.length > 0 ? intervals[intervals.length - 1].end : 0;
  const scale = videoDuration ?? (maxEnd > 0 ? maxEnd : 0);
  const positioned = useMemo(() => {
    if (!(scale > 0)) {
      return [];
    }
    return intervals.map((interval) => ({
      ...interval,
      leftPct: Math.min(100, Math.max(0, (interval.start / scale) * 100)),
      widthPct: Math.max(0.2, ((interval.end - interval.start) / scale) * 100),
    }));
  }, [intervals, scale]);
  const pendingTicks = useMemo(() => {
    if (!(scale > 0)) {
      return [];
    }
    const decoded = new Set(intervals.map((interval) => interval.key));
    return view.rows
      .filter(
        (row) =>
          !decoded.has(row.key) &&
          row.state !== "skipped" &&
          typeof row.timestamp === "number" &&
          Number.isFinite(row.timestamp) &&
          row.timestamp >= 0,
      )
      .map((row) => ({
        key: row.key,
        leftPct: Math.min(100, Math.max(0, (row.timestamp / scale) * 100)),
        state: row.state,
        timestamp: row.timestamp,
      }));
  }, [view.rows, intervals, scale]);
  const ticks = useMemo(() => {
    if (!(scale > 0)) {
      return [];
    }
    const step = tickStepFor(scale);
    const marks = [];
    for (let t = 0; t < scale * 0.97; t += step) {
      marks.push(t);
    }
    return marks;
  }, [scale]);

  const pendingCount = view.rows.filter(
    (row) => row.state === "waiting" || row.state === "generating",
  ).length;
  const blocked = decodeBlocked || audioBlocked;
  const showEmpty =
    !blocked && (view.rows.length === 0 || !(scale > 0));

  return (
    <section aria-label="Commentary timeline" className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-surface">
      <header className="flex h-7 shrink-0 min-w-0 items-center gap-2 border-b border-border px-3">
        <AudioLines className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">
          Commentary timeline
        </span>
        {!showEmpty && !blocked ? (
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-subtle">
            {`${view.ready} ready`}
            {pendingCount > 0 ? ` · ${pendingCount} pending` : ""}
            {view.failed > 0 ? ` · ${view.failed} failed` : ""}
            {view.skipped > 0 ? ` · ${view.skipped} skipped` : ""}
            {manifestInvalid ? " · manifest unreadable" : ""}
          </span>
        ) : null}
        <span ref={timeRef} className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
          00:00 / 00:00
        </span>
      </header>

      <div className="min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
        {blocked ? (
          <p role="status" className="flex h-full items-center px-3 text-[11px] text-muted-foreground">
            Commentary audio is unavailable in this environment (Web Audio is required for the timeline).
          </p>
        ) : showEmpty ? (
          <p role="status" className="flex h-full items-center px-3 text-[11px] text-muted-foreground">
            {view.rows.length === 0
              ? (live
                ? "Commentary segments appear on this timeline as audio finishes generating."
                : "No commentary audio for this project. Generate spoken audio to fill this timeline.")
              : "Waiting for video metadata to place commentary on the timeline."}
          </p>
        ) : (
          <div
            className="relative h-full w-full"
            style={{ minWidth: `${Math.ceil(scale * MIN_PX_PER_SEC)}px` }}
          >
            {positioned.map((interval) => (
              <WaveformRegion
                key={interval.key}
                interval={interval}
                peaks={meta.get(interval.key)?.peaks ?? null}
                active={interval.key === activeKey}
              />
            ))}
            {pendingTicks.map((tick) => (
              <StatusTick
                key={tick.key}
                leftPct={tick.leftPct}
                label={
                  tick.state === "failed" || decodeErrors.has(tick.key)
                    ? `Commentary at ${formatMediaTime(tick.timestamp)}, audio unavailable`
                    : `Commentary at ${formatMediaTime(tick.timestamp)}, ${tick.state}`
                }
                title={decodeErrors.get(tick.key) ?? tick.state}
                tone={
                  tick.state === "failed" || decodeErrors.has(tick.key)
                    ? "bg-destructive"
                    : tick.state === "generating"
                      ? "bg-warning"
                      : "bg-border"
                }
              />
            ))}
            <div
              ref={playheadRef}
              aria-hidden
              className="pointer-events-none absolute inset-y-0 w-px bg-primary"
              style={{ left: "0%", opacity: 0 }}
            />
          </div>
        )}
      </div>

      {!(blocked || showEmpty) ? (
        <footer className="relative h-4 shrink-0 border-t border-border">
          {ticks.map((t) => (
            <span
              key={t}
              aria-hidden
              style={{ left: `${(t / scale) * 100}%` }}
              className="absolute top-0.5 font-mono text-[10px] tabular-nums text-subtle"
            >
              {formatMediaTime(t)}
            </span>
          ))}
        </footer>
      ) : null}

      <ul className="sr-only">
        {view.rows.map((row) => (
          <li key={row.key}>
            {`Commentary at ${formatMediaTime(row.timestamp)}, ${row.state}${
              row.text !== "" ? `: ${row.text}` : ""
            }`}
          </li>
        ))}
      </ul>
    </section>
  );
}
