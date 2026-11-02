"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

// Keep long or accessibility-zoomed panels in ordinary document flow.
export default function StackedPanels({ children }: { children: ReactNode }) {
  const panelsRef = useRef<HTMLDivElement>(null);
  const [stackingEnabled, setStackingEnabled] = useState(false);

  useEffect(() => {
    const panelsRoot = panelsRef.current;
    if (!panelsRoot) return;

    const panels = Array.from(panelsRoot.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement
    );
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    );

    const measure = () => {
      const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
      const shouldStack = window.innerWidth > 800 && !reducedMotion.matches;

      panels.forEach((panel) => {
        const fits =
          shouldStack &&
          panel.getBoundingClientRect().height <= viewportHeight + 1;
        panel.dataset.sticky = fits ? "true" : "false";
      });

      setStackingEnabled((current) =>
        current === shouldStack ? current : shouldStack
      );
    };

    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(measure);

    panels.forEach((panel) => observer?.observe(panel));
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    reducedMotion.addEventListener("change", measure);
    measure();

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
      reducedMotion.removeEventListener("change", measure);
    };
  }, []);

  return (
    <div
      className="panel-stack"
      data-stacking={stackingEnabled ? "enabled" : "disabled"}
      ref={panelsRef}
    >
      {children}
    </div>
  );
}
