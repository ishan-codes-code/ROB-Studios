import { useEffect, useMemo, useRef, useState } from "react";
import { AudioLines, ScrollText } from "lucide-react";
import { Badge } from "@/components/ui/badge.jsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.jsx";
import { buildAudioRows } from "@/lib/audio-rows.js";
import { projectMediaUrl } from "@/lib/format.js";

function TtsBadge({ segment, live }) {
  if (segment.scriptStatus === "superseded") {
    return <Badge variant="outline">Skipped</Badge>;
  }
  if (segment.ttsStatus === "success") {
    return <Badge variant="secondary">Audio ready</Badge>;
  }
  if (segment.ttsStatus === "error") {
    return (
      <Badge variant="destructive" title={segment.ttsError ?? "Audio synthesis failed."}>
        Audio failed
      </Badge>
    );
  }
  if (segment.ttsStatus === "skipped") {
    return <Badge variant="outline">Audio skipped</Badge>;
  }
  if (segment.ttsStatus === "started") {
    return <Badge variant="outline">Audio generating</Badge>;
  }
  return <Badge variant="outline">{live ? "Audio waiting" : "No audio"}</Badge>;
}

function ScriptWorkspace({ script, runStatus }) {
  const segments = script?.segments ?? [];
  const live = runStatus === "processing";
  const ready = segments.filter((entry) => entry.ttsStatus === "success").length;
  const superseded = segments.filter((entry) => entry.scriptStatus === "superseded").length;
  const failed = segments.filter((entry) => entry.ttsStatus === "error").length;
  if (segments.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col items-start justify-center gap-1 px-4">
        <p className="text-[12px] font-medium text-foreground">No script segments yet</p>
        <p className="max-w-xl text-[11px] leading-relaxed text-muted-foreground">
          {live
            ? "Commentary is being generated — lines appear here as they arrive."
            : "Start processing to watch commentary lines appear here, or open script.json under Artifacts after a run."}
        </p>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <p className="shrink-0 truncate px-4 pb-1 pt-2 font-mono text-[10px] tabular-nums text-subtle">
        {segments.length} segment{segments.length === 1 ? "" : "s"}
        {` · ${ready} audio ready`}
        {superseded > 0 ? ` · ${superseded} superseded` : ""}
        {failed > 0 ? ` · ${failed} audio failed` : ""}
      </p>
      <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 pb-2">
        {segments.map((segment) => (
          <li
            key={segment.utteranceId}
            className={`flex min-w-0 items-start gap-2.5 rounded-sm border border-border bg-background px-2.5 py-1.5 ${
              segment.scriptStatus === "superseded" ? "opacity-60" : ""
            }`}
          >
            <span className="mt-px shrink-0 font-mono text-[10px] tabular-nums text-subtle">
              {segment.timestamp.toFixed(1)}s
            </span>
            <span className="min-w-0 flex-1">
              <span
                className="block truncate text-[12px] text-foreground"
                title={segment.text}
              >
                {segment.text}
              </span>
              <span className="block truncate font-mono text-[10px] text-subtle">
                {segment.utteranceId}
                {segment.priority === 0 ? " · urgent" : ""}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-1.5">
              {segment.scriptStatus === "superseded" ? (
                <Badge variant="outline">Superseded</Badge>
              ) : null}
              <TtsBadge segment={segment} live={live} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AudioStateBadge({ row }) {
  switch (row.state) {
    case "ready":
      return <Badge variant="secondary">Ready</Badge>;
    case "generating":
      return <Badge variant="outline">Generating</Badge>;
    case "waiting":
      return <Badge variant="outline">Waiting</Badge>;
    case "failed":
      return (
        <Badge variant="destructive" title={row.error ?? "Audio synthesis failed."}>
          Failed
        </Badge>
      );
    case "unavailable":
      return <Badge variant="destructive">Unavailable</Badge>;
    case "skipped":
      return <Badge variant="outline">Skipped</Badge>;
    case "no-audio":
      return <Badge variant="outline">No audio</Badge>;
    default:
      return <Badge variant="outline">{row.rawStatus ?? "Unknown"}</Badge>;
  }
}

function AudioWorkspace({ projectId, view, runStatus, manifestInvalid, broken, onBroken }) {
  const live = runStatus === "processing";
  const { rows, ready, total, failed, skipped } = view;
  if (rows.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col items-start justify-center gap-1 px-4">
        <p className="text-[12px] font-medium text-foreground">No audio segments yet</p>
        <p className="max-w-xl text-[11px] leading-relaxed text-muted-foreground">
          {live
            ? "Finished segments appear here while the run continues — play them without waiting for the video to end."
            : "Request spoken audio when starting a run, or open the Audio tab under Artifacts after a run."}
        </p>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <p className="shrink-0 truncate px-4 pb-1 pt-2 font-mono text-[10px] tabular-nums text-subtle">
        {`Audio: ${ready} / ${total} ready`}
        {failed > 0 ? ` · ${failed} failed` : ""}
        {skipped > 0 ? ` · ${skipped} skipped` : ""}
        {manifestInvalid ? " · manifest unreadable" : ""}
      </p>
      <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-3 pb-2">
        {rows.map((row) => {
          const loadFailed = row.state === "ready" && broken.has(row.key);
          return (
            <li
              key={row.key}
              className="flex min-w-0 flex-col gap-1 rounded-sm border border-border bg-background px-2.5 py-1.5"
            >
              <div className="flex min-w-0 items-start gap-2.5">
                <span className="mt-px shrink-0 font-mono text-[10px] tabular-nums text-subtle">
                  {row.timestamp === null ? "—" : `${row.timestamp.toFixed(1)}s`}
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className="block truncate text-[12px] text-foreground"
                    title={row.text === "" ? row.title : row.text}
                  >
                    {row.text === "" ? row.title : row.text}
                  </span>
                  <span className="block truncate font-mono text-[10px] text-subtle">
                    {row.title}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {loadFailed ? (
                    <Badge variant="destructive">Unavailable</Badge>
                  ) : (
                    <AudioStateBadge row={row} />
                  )}
                </span>
              </div>
              {row.state === "failed" && row.error ? (
                <p className="truncate text-[10px] text-muted-foreground" title={row.error}>
                  {row.error}
                </p>
              ) : null}
              {row.state === "unavailable" ? (
                <p className="text-[10px] text-muted-foreground">
                  Success was reported but no audio file was found.
                </p>
              ) : null}
              {loadFailed ? (
                <p className="text-[10px] text-muted-foreground">
                  The file could not be loaded for playback.
                </p>
              ) : row.state === "ready" && row.scope && row.name ? (
                <audio
                  controls
                  preload="none"
                  src={projectMediaUrl(projectId, row.scope, row.name)}
                  onError={() => onBroken(row.key)}
                  className="w-full"
                  aria-label={`Play ${row.title}`}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function CountBadge({ count }) {
  // Always rendered (invisible at zero) so streaming counts never shift
  // the tab strip while the user is about to click.
  return (
    <span
      aria-hidden={count === 0}
      className={`min-w-4 text-center font-mono text-[10px] tabular-nums text-subtle ${
        count === 0 ? "invisible" : ""
      }`}
    >
      {count}
    </span>
  );
}

const PANELS = [
  { id: "audio", label: "Audio", icon: AudioLines },
  { id: "script", label: "Script", icon: ScrollText },
];

export default function DockedWorkspace({ projectId = null, script = null, runStatus = "idle" }) {
  const [activePanel, setActivePanel] = useState("audio");
  const [audioFiles, setAudioFiles] = useState([]);
  const [ttsEntries, setTtsEntries] = useState(null);
  const [manifestInvalid, setManifestInvalid] = useState(false);
  const [broken, setBroken] = useState(() => new Set());
  const prevRunStatus = useRef(runStatus);

  // A new run reuses segment filenames: forget unloadable files when a
  // run starts or the project changes so rows rejoin honestly.
  useEffect(() => {
    const started = prevRunStatus.current !== "processing" && runStatus === "processing";
    prevRunStatus.current = runStatus;
    if (started) {
      setBroken(new Set());
    }
  }, [runStatus]);
  useEffect(() => {
    setBroken(new Set());
  }, [projectId]);

  // Refresh discovered audio whenever segments stream in or the run
  // settles; the finalized manifest takes over the join once written.
  useEffect(() => {
    if (!projectId || typeof window.api?.listArtifacts !== "function") {
      return;
    }
    let alive = true;
    async function load() {
      try {
        const res = await window.api.listArtifacts(projectId);
        if (!alive || !res || res.ok !== true || !res.artifacts) {
          return;
        }
        const files = Array.isArray(res.artifacts.audio?.files)
          ? res.artifacts.audio.files
          : [];
        let entries = null;
        let invalid = false;
        const tts = res.artifacts.tts;
        if (tts?.present === true && tts?.invalid !== true) {
          if (typeof window.api?.readArtifact === "function") {
            try {
              const doc = await window.api.readArtifact(projectId, "tts");
              if (doc?.ok === true && Array.isArray(doc.data?.entries)) {
                entries = doc.data.entries;
              } else {
                invalid = true;
              }
            } catch {
              invalid = true;
            }
          }
        } else if (tts?.present === true) {
          invalid = true;
        }
        if (alive) {
          setAudioFiles(files);
          setTtsEntries(entries);
          setManifestInvalid(invalid);
        }
      } catch {
        // Keep the previous listing; rows explain themselves.
      }
    }
    load();
    return () => {
      alive = false;
    };
  }, [projectId, script, runStatus]);

  const segments = useMemo(
    () => (Array.isArray(script?.segments) ? script.segments : []),
    [script],
  );
  const view = useMemo(
    () =>
      buildAudioRows({
        segments,
        files: audioFiles,
        entries: ttsEntries,
        live: runStatus === "processing",
      }),
    [segments, audioFiles, ttsEntries, runStatus],
  );
  // Files that fail to load stop counting as ready everywhere the
  // dock reports counts, so the tab badge and the panel header agree.
  const displayView = useMemo(() => {
    if (broken.size === 0) {
      return view;
    }
    const loadFailed = view.rows.filter(
      (row) => row.state === "ready" && broken.has(row.key),
    ).length;
    if (loadFailed === 0) {
      return view;
    }
    return { ...view, ready: view.ready - loadFailed, failed: view.failed + loadFailed };
  }, [view, broken]);

  return (
    <section aria-label="Bottom workspace" className="h-[196px] min-h-0 border-t border-border bg-surface">
      <Tabs value={activePanel} onValueChange={setActivePanel} className="flex h-full min-h-0 flex-col gap-0">
        <TabsList variant="line" aria-label="Bottom workspace panels" className="h-9 w-full shrink-0 gap-1 rounded-none border-b border-border px-3 py-0">
          {PANELS.map(({ id, label, icon: Icon }) => (
            <TabsTrigger key={id} value={id} className="h-8 flex-initial rounded-sm px-3 text-[11px]">
              <Icon className="size-3.5" aria-hidden />
              {label}
              {id === "script" ? (
                <CountBadge count={segments.length} />
              ) : (
                <CountBadge count={displayView.ready} />
              )}
            </TabsTrigger>
          ))}
        </TabsList>
        {/* Stable per-tab contents, always mounted: switching tabs never
            unmounts the other panel, so audio playback, scroll position,
            and focus survive tab switches instead of flashing. The
            inactive panel is display:none (forceMount alone leaves both
            visible, stacking them inside the fixed tray). */}
        <TabsContent
          value="audio"
          forceMount
          className={`m-0 min-h-0 flex-1 overflow-hidden ${activePanel === "audio" ? "" : "hidden"}`}
        >
          <AudioWorkspace
            projectId={projectId}
            view={displayView}
            runStatus={runStatus}
            manifestInvalid={manifestInvalid}
            broken={broken}
            onBroken={(key) =>
              setBroken((prev) => {
                if (prev.has(key)) {
                  return prev;
                }
                return new Set(prev).add(key);
              })
            }
          />
        </TabsContent>
        <TabsContent
          value="script"
          forceMount
          className={`m-0 min-h-0 flex-1 overflow-hidden ${activePanel === "script" ? "" : "hidden"}`}
        >
          <ScriptWorkspace script={script} runStatus={runStatus} />
        </TabsContent>
      </Tabs>
    </section>
  );
}
