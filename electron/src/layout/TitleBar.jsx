import { AudioLines } from "lucide-react";

// The overlay reserves the top-right corner for native caption controls
// on Windows only; other platforms keep the fully native frame, so no
// spacer is needed there.
function isWindowsChrome() {
  if (typeof navigator === "undefined") return false;
  const platform = navigator.userAgentData?.platform ?? navigator.platform ?? "";
  return /win/i.test(platform);
}

// Integrated window title bar. The whole bar is a drag region (double-click
// toggles maximize natively); it carries no interactive elements, so
// nothing here can swallow clicks meant for the shell beneath.
export default function TitleBar({ context }) {
  return (
    <header
      aria-label="ROB Studio window title bar"
      className="flex h-9 shrink-0 select-none items-center gap-2.5 border-b border-border bg-surface pl-3"
      style={{ WebkitAppRegion: "drag" }}
    >
      <span className="flex size-5 shrink-0 items-center justify-center rounded-sm bg-foreground text-background">
        <AudioLines className="size-3" aria-hidden />
      </span>
      <span className="shrink-0 text-[12px] font-semibold tracking-[-0.01em] text-foreground">
        ROB Studio
      </span>
      {context ? (
        <span className="hidden min-w-0 truncate text-[11px] text-subtle sm:inline">
          {context}
        </span>
      ) : null}
      <span className="min-w-0 flex-1" aria-hidden />
      {isWindowsChrome() ? <span className="w-[140px] shrink-0" aria-hidden /> : null}
    </header>
  );
}
