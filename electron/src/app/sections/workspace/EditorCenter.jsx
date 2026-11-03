import { useRef } from "react";
import { ArrowLeft, Activity } from "lucide-react";
import { Button } from "@/components/ui/button.jsx";
import { Separator } from "@/components/ui/separator.jsx";
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

/**
 * Central editor column: project header, gameplay preview, and the
 * commentary timeline. The preview is always visible (no view tabs);
 * project diagnostics live behind a secondary dialog so artifact
 * browsing never competes with the preview.
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

  function handleDiagnosticsOpenChange(open) {
    if (open) {
      videoRef.current?.pause();
    }
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <div className="flex h-10 min-w-0 shrink-0 items-center gap-2 border-b border-border bg-surface px-2">
        <Button type="button" size="sm" variant="ghost" onClick={onBack}>
          <ArrowLeft data-icon="inline-start" />
          Projects
        </Button>
        <Separator orientation="vertical" className="h-4" />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
          {project.name}
        </span>
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
          script={script}
          runStatus={runStatus}
          audio={audio}
        />
      </div>
    </div>
  );
}
