import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AudioLines, AudioWaveform, TriangleAlert } from "lucide-react";
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

const WaveformRegion = memo(function WaveformRegion({
  leftPct,
  widthPct,
  start,
  length,
  title,
  peaks,
  active,
}) {
  const path = useMemo(() => peaksToPath(peaks ?? PLACEHOLDER_PEAKS), [peaks]);
  const decoded = Array.isArray(peaks);
  return (
    <div
      role="img"
      aria-label={
        `Commentary at ${formatMediaTime(start)}` +
        `${decoded ? `, ${formatMediaTime(length)} long` : ", loading waveform"}` +
        `${active ? ", playing" : ""}`
      }
      title={title}
      style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
      className={`absolute inset-y-1 overflow-hidden rounded-sm border-x ${
        active ? "border-muted-foreground/50 bg-secondary/50" : "border-border/60"
      }`}
    >
      <div aria-hidden className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border/70" />
      <svg
        viewBox={`0 0 ${WAVEFORM_VIEWBOX_WIDTH} ${WAVEFORM_VIEWBOX_HEIGHT}`}
        preserveAspectRatio="none"
        aria-hidden
        className={`relative block h-full w-full ${
          active ? "text-foreground" : decoded ? "text-muted-foreground/80" : "text-subtle/50"
        }`}
        fill="currentColor"
      >
        <path d={path} />
      </svg>
    </div>
  );
});

const StatusTick = memo(function StatusTick({ leftPct, label, title, tone }) {
  return (
    <div
      role="img"
      aria-label={label}
      title={title}
      style={{ left: `${leftPct}%` }}
      className={`absolute top-1/2 h-2/3 w-0.5 -translate-y-1/2 rounded-full ${tone}`}
    />
  );
});

function tickTone(row, hasDecodeError) {
  if (row.state === "failed" || row.state === "unavailable" || hasDecodeError) {
    return "bg-destructive";
  }
  if (row.state === "generating") {
    return "bg-warning";
  }
  if (row.state === "waiting") {
    return "bg-muted-foreground";
  }
  return "bg-border";
}

function TimelineState({ icon: Icon, tone, title, body }) {
  return (
    <div role="status" className="flex h-full min-h-0 flex-col items-center justify-center gap-1 px-4 text-center">
      <Icon className={`size-5 ${tone}`} aria-hidden />
      <p className="text-[12px] font-medium text-foreground">{title}</p>
      <p className="max-w-xl text-[11px] leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
}

export default function CommentaryTimeline({ projectId = null, videoRef = null, view = null, runStatus = "idle", audio = null }) {
  const rows = view?.rows ?? [];
  const manifestInvalid = audio?.manifestInvalid === true;
  const live = runStatus === "processing";
  const { meta, decodeErrors, decodeBlocked } = useCommentaryAudio(projectId, rows, runStatus);
  const durations = useMemo(() => {
    const map = new Map();
    for (const [key, entry] of meta) {
      map.set(key, entry.duration);
    }
    return map;
  }, [meta]);
  const intervals = useMemo(
    () => buildIntervals(rows, durations),
    [rows, durations],
  );
  const getBuffer = useCallback((key) => peekCachedBuffer(projectId, key), [projectId]);
  const playheadRef = useRef(null);
  const timeRef = useRef(null);
  const scrollRef = useRef(null);
  const rulerScrollRef = useRef(null);
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
    return rows
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
  }, [rows, intervals, scale]);
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

  const contentMinWidth = `${Math.ceil(Math.max(scale, 0) * MIN_PX_PER_SEC)}px`;
  const handleScroll = useCallback((event) => {
    if (rulerScrollRef.current) {
      rulerScrollRef.current.scrollLeft = event.currentTarget.scrollLeft;
    }
  }, []);

  const pendingCount = rows.filter(
    (row) => row.state === "waiting" || row.state === "generating",
  ).length;
  const blocked = decodeBlocked || audioBlocked;
  const showEmpty =
    !blocked && (rows.length === 0 || !(scale > 0));

  return (
    <section aria-label="Commentary timeline" className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-surface">
      <header className="flex h-8 min-w-0 shrink-0 items-center gap-2.5 border-b border-border px-3">
        <AudioLines className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
          Commentary timeline
        </span>
        {!showEmpty && !blocked ? (
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-subtle">
            {`${view?.ready ?? 0} ready`}
            {pendingCount > 0 ? ` · ${pendingCount} pending` : ""}
            {(view?.failed ?? 0) > 0 ? ` · ${view.failed} failed` : ""}
            {(view?.skipped ?? 0) > 0 ? ` · ${view.skipped} skipped` : ""}
            {manifestInvalid ? " · manifest unreadable" : ""}
          </span>
        ) : null}
        <span ref={timeRef} className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
          00:00 / 00:00
        </span>
      </header>

      <div ref={scrollRef} onScroll={handleScroll} className="min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
        {blocked ? (
          <TimelineState
            icon={TriangleAlert}
            tone="text-warning"
            title="Timeline unavailable"
            body="Commentary audio needs Web Audio, which this environment does not provide. Script text and artifacts remain available."
          />
        ) : showEmpty ? (
          rows.length === 0 ? (
            <TimelineState
              icon={AudioWaveform}
              tone="text-subtle"
              title="No commentary audio"
              body={
                live
                  ? "Commentary segments appear on this timeline as audio finishes generating."
                  : "Runs generate spoken audio automatically when a TTS voice is configured."
              }
            />
          ) : (
            <TimelineState
              icon={AudioWaveform}
              tone="text-subtle"
              title="Placing commentary"
              body="Waiting for video metadata to place commentary on the timeline."
            />
          )
        ) : (
          <div
            className="relative h-full w-full"
            style={{ minWidth: contentMinWidth }}
          >
            {positioned.map((interval) => (
              <WaveformRegion
                key={interval.key}
                leftPct={interval.leftPct}
                widthPct={interval.widthPct}
                start={interval.start}
                length={interval.end - interval.start}
                title={interval.text === "" ? interval.title : interval.text}
                peaks={meta.get(interval.key)?.peaks ?? null}
                active={interval.key === activeKey}
              />
            ))}
            {pendingTicks.map((tick) => {
              const hasDecodeError = decodeErrors.has(tick.key);
              return (
                <StatusTick
                  key={tick.key}
                  leftPct={tick.leftPct}
                  label={
                    tick.state === "failed" || tick.state === "unavailable" || hasDecodeError
                      ? `Commentary at ${formatMediaTime(tick.timestamp)}, audio unavailable`
                      : `Commentary at ${formatMediaTime(tick.timestamp)}, ${tick.state}`
                  }
                  title={decodeErrors.get(tick.key) ?? tick.state}
                  tone={tickTone(tick, hasDecodeError)}
                />
              );
            })}
            <div
              ref={playheadRef}
              aria-hidden
              className="pointer-events-none absolute inset-y-0"
              style={{ left: "0%", opacity: 0 }}
            >
              <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-primary" />
              <div className="absolute left-1/2 top-0.5 size-1.5 -translate-x-1/2 rotate-45 bg-primary" />
            </div>
          </div>
        )}
      </div>

      {!(blocked || showEmpty) ? (
        <footer className="h-4 shrink-0 overflow-hidden border-t border-border">
          <div ref={rulerScrollRef} className="h-full overflow-hidden">
            <div className="relative h-full w-full" style={{ minWidth: contentMinWidth }}>
              {ticks.map((t) => (
                <span
                  key={t}
                  aria-hidden
                  style={{ left: `${(t / scale) * 100}%` }}
                  className="absolute inset-y-0"
                >
                  <span className="block h-[3px] w-px bg-border" />
                  <span className="mt-px block font-mono text-[10px] leading-none tabular-nums text-subtle">
                    {formatMediaTime(t)}
                  </span>
                </span>
              ))}
            </div>
          </div>
        </footer>
      ) : null}

      <ul className="sr-only">
        {rows.map((row) => (
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
