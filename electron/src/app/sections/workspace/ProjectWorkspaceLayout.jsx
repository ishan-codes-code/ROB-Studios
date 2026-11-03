import { useCallback, useState } from "react";
import { motion } from "motion/react";
import { MOTION } from "@/lib/tokens.js";
import {
  INSPECTOR_DEFAULT_WIDTH,
  INSPECTOR_MAX_WIDTH,
  INSPECTOR_MIN_WIDTH,
  clampInspectorWidth,
  stepInspectorWidth,
} from "@/lib/inspector-width.js";

function Splitter({ width, onWidthChange, onReset, onDraggingChange }) {
  const [active, setActive] = useState(false);
  function handlePointerDown(event) {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    const target = event.currentTarget;
    const startX = event.clientX;
    const startWidth = width;
    onDraggingChange(true);
    setActive(true);
    function handleMove(moveEvent) {
      onWidthChange(clampInspectorWidth(startWidth + (startX - moveEvent.clientX)));
    }
    function handleUp() {
      target.removeEventListener("pointermove", handleMove);
      target.removeEventListener("pointerup", handleUp);
      target.removeEventListener("pointercancel", handleUp);
      onDraggingChange(false);
      setActive(false);
    }
    target.setPointerCapture?.(event.pointerId);
    target.addEventListener("pointermove", handleMove);
    target.addEventListener("pointerup", handleUp);
    target.addEventListener("pointercancel", handleUp);
  }

  function handleKeyDown(event) {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onWidthChange(stepInspectorWidth(width, 1, event.shiftKey));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      onWidthChange(stepInspectorWidth(width, -1, event.shiftKey));
    } else if (event.key === "Home") {
      event.preventDefault();
      onWidthChange(INSPECTOR_MIN_WIDTH);
    } else if (event.key === "End") {
      event.preventDefault();
      onWidthChange(INSPECTOR_MAX_WIDTH);
    }
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize inspector"
      aria-valuemin={INSPECTOR_MIN_WIDTH}
      aria-valuemax={INSPECTOR_MAX_WIDTH}
      aria-valuenow={Math.round(width)}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
      onDoubleClick={onReset}
      title="Drag to resize the inspector (double-click to reset)"
      className="group relative w-2 shrink-0 cursor-col-resize touch-none select-none outline-none"
    >
      <div
        aria-hidden
        className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors duration-150 group-hover:bg-muted-foreground group-focus-visible:bg-ring ${
          active ? "bg-ring" : "bg-border"
        }`}
      />
    </div>
  );
}

/**
 * Editor grid: central workspace plus a resizable right inspector. The
 * preview consumes the remaining width; the inspector clamps into a
 * usable range, collapses to zero when closed, and keeps its content
 * mounted (inert) so tab state and scroll survive a toggle.
 */
export default function ProjectWorkspaceLayout({ main, inspector, inspectorOpen }) {
  const [width, setWidth] = useState(INSPECTOR_DEFAULT_WIDTH);
  const [dragging, setDragging] = useState(false);

  const handleWidthChange = useCallback((next) => {
    setWidth(clampInspectorWidth(next));
  }, []);
  const handleReset = useCallback(() => {
    setWidth(INSPECTOR_DEFAULT_WIDTH);
  }, []);
  const handleDraggingChange = useCallback((next) => {
    setDragging(next);
  }, []);

  return (
    <div className="flex h-full min-h-0 min-w-0 overflow-hidden">
      <main className="min-h-0 min-w-0 flex-1 overflow-hidden">{main}</main>
      {inspectorOpen ? (
        <Splitter
          width={width}
          onWidthChange={handleWidthChange}
          onReset={handleReset}
          onDraggingChange={handleDraggingChange}
        />
      ) : null}
      <motion.aside
        id="project-inspector"
        aria-label="Project inspector"
        aria-hidden={!inspectorOpen}
        inert={!inspectorOpen}
        initial={false}
        animate={inspectorOpen ? { opacity: 1 } : { opacity: 0 }}
        transition={{ duration: MOTION.fast }}
        style={{ width: inspectorOpen ? width : 0 }}
        className={`h-full min-h-0 shrink-0 overflow-hidden bg-surface motion-reduce:transition-none ${
          inspectorOpen ? "border-l border-border" : "pointer-events-none border-l border-transparent"
        } ${dragging ? "" : "transition-[width] duration-150 ease-out"}`}
      >
        <div style={{ width }} className="@container h-full min-h-0 min-w-0">
          {inspector}
        </div>
      </motion.aside>
    </div>
  );
}
