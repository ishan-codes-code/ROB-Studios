"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { setupCinematicScenes } from "./cinematic/choreography";

// Layout effect on the client, plain effect during SSR (avoids the SSR
// warning while still setting initial animation states before paint).
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

// Single eligibility model: a panel is sticky-eligible only when stacking is
// globally allowed (wide viewport, motion allowed) AND its layout height
// fits the viewport. `data-sticky` on each panel is the source of truth;
// `data-stacking` on the root is enabled only when at least one panel is
// eligible, and the GSAP handoffs read the same per-panel flags.
export default function StackedPanels({ children }: { children: ReactNode }) {
  const panelsRef = useRef<HTMLDivElement>(null);
  const [stackingEnabled, setStackingEnabled] = useState(false);
  // Signature of per-panel eligibility, e.g. "110100". GSAP setup re-runs
  // when it changes so triggers always agree with the physical layout.
  const [eligibilityKey, setEligibilityKey] = useState("");

  useIsomorphicLayoutEffect(() => {
    const panelsRoot = panelsRef.current;
    if (!panelsRoot) return;

    const panels = Array.from(panelsRoot.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement
    );
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    );

    let raf = 0;
    const measure = () => {
      const viewportHeight =
        window.visualViewport?.height ?? window.innerHeight;
      const allowed = window.innerWidth > 800 && !reducedMotion.matches;

      let anyEligible = false;
      const key = panels
        .map((panel) => {
          // offsetHeight is layout height, unaffected by GSAP transforms
          // on inner surfaces (getBoundingClientRect would include them).
          const fits = allowed && panel.offsetHeight <= viewportHeight + 1;
          panel.dataset.sticky = fits ? "true" : "false";
          if (fits) anyEligible = true;
          return fits ? "1" : "0";
        })
        .join("");

      setStackingEnabled((current) =>
        current === anyEligible ? current : anyEligible
      );
      setEligibilityKey((current) => (current === key ? current : key));
    };
    // Throttle observer/resize bursts to one measure per frame; writing
    // data attributes does not change panel size, so no observer loop.
    const scheduleMeasure = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        measure();
      });
    };

    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleMeasure);

    panels.forEach((panel) => observer?.observe(panel));
    window.addEventListener("resize", scheduleMeasure);
    window.visualViewport?.addEventListener("resize", scheduleMeasure);
    reducedMotion.addEventListener("change", scheduleMeasure);
    measure();

    return () => {
      if (raf) cancelAnimationFrame(raf);
      observer?.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
      window.visualViewport?.removeEventListener("resize", scheduleMeasure);
      reducedMotion.removeEventListener("change", scheduleMeasure);
    };
  }, []);

  // Visual storytelling inside the panels. Physical stacking stays owned by
  // the measurement above and by CSS sticky; this effect only animates inner
  // content and decorative elements, never panel positioning. It re-runs
  // when eligibility changes so handoffs exist only for eligible pairs.
  useIsomorphicLayoutEffect(() => {
    const panelsRoot = panelsRef.current;
    if (!panelsRoot) return;
    return setupCinematicScenes(panelsRoot);
  }, [eligibilityKey]);

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
