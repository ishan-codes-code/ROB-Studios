import { useState } from "react";
import { AudioLines, ScrollText } from "lucide-react";
import { Badge } from "@/components/ui/badge.jsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.jsx";

const TRACKS = [
  { id: "video", label: "Gameplay video", detail: "Source available" },
  { id: "game-audio", label: "Original game audio", detail: "Not extracted" },
  { id: "commentary", label: "AI commentary", detail: "Not generated" },
];

function AudioWorkspace() {
  return (
    <div className="grid h-full min-h-0 grid-rows-3 px-3">
      {TRACKS.map((track) => (
        <div key={track.id} className="grid min-h-0 grid-cols-[148px_minmax(0,1fr)] items-center gap-3 border-b border-border last:border-b-0">
          <div className="flex min-w-0 flex-col gap-0.5 pr-2">
            <span className="truncate text-[11px] font-medium text-foreground">{track.label}</span>
            <span className="truncate text-[10px] text-subtle">{track.detail}</span>
          </div>
          <div className="flex h-7 min-w-0 items-center rounded-sm border border-border bg-background px-3">
            <span className="truncate text-[10px] text-subtle">Playback lane unavailable</span>
          </div>
        </div>
      ))}
    </div>
  );
}

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
  return <Badge variant="outline">{live ? "Audio pending" : "No audio"}</Badge>;
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
            ? "Streaming commentary is running — worded lines appear here as they are generated."
            : "Run with Streaming commentary to watch lines appear here, or open script.json under Artifacts after a script run."}
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

const PANELS = [
  { id: "audio", label: "Audio", icon: AudioLines },
  { id: "script", label: "Script", icon: ScrollText },
];

export default function DockedWorkspace({ script = null, runStatus = "idle" }) {
  const [activePanel, setActivePanel] = useState("audio");

  return (
    <section aria-label="Bottom workspace" className="h-[196px] min-h-0 border-t border-border bg-surface">
      <Tabs value={activePanel} onValueChange={setActivePanel} className="flex h-full min-h-0 flex-col gap-0">
        <TabsList variant="line" aria-label="Bottom workspace panels" className="h-9 w-full shrink-0 gap-1 rounded-none border-b border-border px-3 py-0">
          {PANELS.map(({ id, label, icon: Icon }) => (
            <TabsTrigger key={id} value={id} className="h-8 flex-initial rounded-sm px-3 text-[11px]">
              <Icon className="size-3.5" aria-hidden />
              {label}
              {id === "script" && (script?.segments?.length ?? 0) > 0 ? (
                <span className="font-mono text-[10px] tabular-nums text-subtle">
                  {script.segments.length}
                </span>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value={activePanel} className="m-0 min-h-0 flex-1 overflow-hidden">
          {activePanel === "script" ? (
            <ScriptWorkspace script={script} runStatus={runStatus} />
          ) : (
            <AudioWorkspace />
          )}
        </TabsContent>
      </Tabs>
    </section>
  );
}
