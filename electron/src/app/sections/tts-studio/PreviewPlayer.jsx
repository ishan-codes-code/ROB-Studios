import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.jsx";
import { Spinner } from "@/components/ui/spinner.jsx";
import { formatBytes } from "@/lib/format.js";

/**
 * Honest preview playback: native audio controls (play, pause, replay,
 * seek) over a temporary object URL. No fake waveforms or progress.
 */
export default function PreviewPlayer({ status, audioUrl, bytes, caption, error }) {
  if (status === "loading") {
    return (
      <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <Spinner /> Generating audio…
      </p>
    );
  }
  if (status === "error") {
    return (
      <Alert variant="destructive">
        <AlertTitle>Preview failed</AlertTitle>
        <AlertDescription className="min-w-0 [overflow-wrap:anywhere]">
          {error || "Could not generate preview audio."}
        </AlertDescription>
      </Alert>
    );
  }
  if (status === "ready" && audioUrl) {
    return (
      <div className="flex min-w-0 flex-col gap-1.5">
        <audio controls src={audioUrl} className="w-full" preload="metadata" />
        <p className="text-[11px] text-subtle">
          {caption} · {formatBytes(bytes)} · Replaying reuses this audio without a new request.
        </p>
      </div>
    );
  }
  return (
    <p className="text-[12px] leading-relaxed text-muted-foreground">
      No audio yet. Generate a preview to hear the current voice settings.
    </p>
  );
}
