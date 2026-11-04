// Cinematic scroll choreography for the marketing page.
//
// Architecture rule: CSS sticky owns physical panel stacking; GSAP owns only
// visual storytelling *inside* panels (transform/opacity of inner content).
// No ScrollTrigger pinning, no panel positioning, no layout-property animation,
// so oversized panels, mobile fallback, and reduced-motion fallback keep
// working exactly as the sticky implementation defines them.

import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

type SceneConditions = {
  isDesktop?: boolean;
  isMobile?: boolean;
  reduceMotion?: boolean;
};

const ENTER = "play none none reverse";
const EASE = "power3.out";

let pluginRegistered = false;

function ensurePlugin() {
  if (pluginRegistered || typeof window === "undefined") return;
  gsap.registerPlugin(ScrollTrigger);
  pluginRegistered = true;
}

export function setupCinematicScenes(root: HTMLElement): () => void {
  ensurePlugin();
  const mm = gsap.matchMedia();
  const disposers: Array<() => void> = [];

  mm.add(
    {
      // Exhaustive: exactly one of isDesktop/isMobile always matches, so the
      // handler runs on every viewport (gsap.matchMedia skips the callback
      // when no named query matches). Reduced motion still creates nothing.
      isDesktop: "(min-width: 801px)",
      isMobile: "(max-width: 800px)",
      reduceMotion: "(prefers-reduced-motion: reduce)",
    },
    (context) => {
      const conditions = (context.conditions ?? {}) as SceneConditions;
      // Reduced motion: create nothing, so every panel stays fully visible
      // in the normal-scroll fallback that StackedPanels already provides.
      if (conditions.reduceMotion) return;
      const isDesktop = conditions.isDesktop ?? true;
      const select = gsap.utils.selector(root);
      const first = (selector: string): Element | null =>
        select(selector)[0] ?? null;

      const reveal = (
        targets: Element | Element[],
        trigger: Element,
        options?: {
          start?: string;
          y?: number;
          duration?: number;
          stagger?: number;
        },
      ) => {
        const list = Array.isArray(targets) ? targets : [targets];
        if (list.length === 0) return;
        gsap.from(list, {
          y: options?.y ?? (isDesktop ? 28 : 18),
          autoAlpha: 0,
          duration: options?.duration ?? 0.9,
          stagger: options?.stagger ?? 0.09,
          ease: EASE,
          overwrite: "auto",
          scrollTrigger: {
            trigger,
            start: options?.start ?? "top 78%",
            toggleActions: ENTER,
          },
        });
      };

      // ---- Hero: load entrance (GlitchText line untouched) ----
      gsap
        .timeline({ defaults: { ease: EASE } })
        .from(select(".hero-kicker"), { y: 16, autoAlpha: 0, duration: 0.8 }, 0.15)
        .from(
          select(".hero-title-second"),
          { y: isDesktop ? 44 : 30, autoAlpha: 0, duration: 1.15 },
          0.28,
        )
        .from(select(".hero-title + p"), { y: 24, autoAlpha: 0, duration: 0.9 }, 0.5)
        .from(select(".hero-ctas"), { y: 16, autoAlpha: 0, duration: 0.8 }, 0.62)
        .from(select(".hero-explore"), { y: 12, autoAlpha: 0, duration: 0.7 }, 0.7);

      // ---- Scene handoffs: every following panel pushes its predecessor
      // back as it begins to overlap. The panels themselves never transform;
      // CSS sticky remains the only owner of their physical placement.
      if (isDesktop) {
        const panels = Array.from(root.children).filter(
          (child): child is HTMLElement => child instanceof HTMLElement,
        );
        const scenes = panels.map((panel) => {
          const surface = panel.querySelector(":scope > .scene-surface");
          return surface instanceof HTMLElement ? surface : null;
        });

        scenes.slice(0, -1).forEach((outgoingScene, index) => {
          const incomingPanel = panels[index + 1];
          const outgoingPanel = panels[index];
          if (!outgoingScene || !incomingPanel || !outgoingPanel) return;
          // Only animate a handoff that physically happens: both panels
          // must be sticky-eligible (same flags StackedPanels measured).
          // Otherwise the incoming panel flows normally and the outgoing
          // scene must stay fully visible until it scrolls away naturally.
          if (
            outgoingPanel.dataset.sticky !== "true" ||
            incomingPanel.dataset.sticky !== "true"
          )
            return;

          const isHero = index === 0;
          gsap.to(outgoingScene, {
            scale: isHero ? 0.96 : 0.97,
            y: isHero ? -14 : -10,
            opacity: isHero ? 0.65 : 0.75,
            ease: "none",
            transformOrigin: "center center",
            scrollTrigger: {
              trigger: incomingPanel,
              // Recession tracks the incoming panel's real travel: it
              // starts when its top enters at the viewport bottom and
              // completes exactly when it reaches its sticky position
              // at the top and fully covers the outgoing scene.
              start: "top bottom",
              end: "top top",
              scrub: true,
              invalidateOnRefresh: true,
              refreshPriority: index,
            },
          });
        });
      }

      // ---- Product introduction: staggered scene reveal + signal depth ----
      const introSection = first(".introduction-section");
      const introSignal = first(".intro-signal");
      if (introSection) {
        reveal(
          select(
            ".introduction-section .section-index, .introduction-section .display-heading, .introduction-section .body-copy",
          ),
          introSection,
          { start: "top 75%", y: isDesktop ? 34 : 20 },
        );
        if (introSignal) {
          gsap.from(introSignal, {
            y: 26,
            autoAlpha: 0,
            scale: 0.94,
            duration: 1.1,
            ease: EASE,
            overwrite: "auto",
            scrollTrigger: {
              trigger: introSection,
              start: "top 70%",
              toggleActions: ENTER,
            },
          });
          // No scrub parallax here: it would fight the reveal tween above
          // for the same `y` transform on this element.
        }
      }

      // ---- Showcase / Demo / Studio: frame + stage reveals ----
      for (const [sectionSel, targets] of [
        [".showcase-section", ".showcase-section .section-index, .showcase-section .section-heading, .showcase-section .body-copy"],
        [".demo-section", ".demo-section .section-index, .demo-section .section-heading, .demo-section .body-copy"],
        [".studio-section", ".studio-section .section-index, .studio-section .section-heading, .studio-section .body-copy"],
      ] as const) {
        const sec = first(sectionSel);
        if (sec) reveal(select(targets), sec, { y: isDesktop ? 26 : 18 });
      }
      const showcaseFrame = first(".showcase-frame");
      if (showcaseFrame) gsap.from(showcaseFrame, { y: isDesktop ? 36 : 20, autoAlpha: 0, duration: 1, ease: EASE, overwrite: "auto", scrollTrigger: { trigger: showcaseFrame, start: "top 82%", toggleActions: ENTER } });
      const demoPipeline = first(".demo-pipeline");
      if (demoPipeline) gsap.from(select(".demo-stage"), { y: 22, autoAlpha: 0, duration: 0.7, stagger: 0.12, ease: "power2.out", overwrite: "auto", scrollTrigger: { trigger: demoPipeline, start: "top 80%", toggleActions: ENTER } });
      const studioFrame = first(".studio-frame");
      if (studioFrame) gsap.from(studioFrame, { y: isDesktop ? 40 : 22, autoAlpha: 0, duration: 1, ease: EASE, overwrite: "auto", scrollTrigger: { trigger: studioFrame, start: "top 82%", toggleActions: ENTER } });

      // ---- Capabilities: structured row-by-row reveal ----
      const capabilitiesSection = first(".capabilities-section");
      const capabilityList = first(".capability-list");
      if (capabilitiesSection) {
        reveal(
          select(
            ".capabilities-section .section-index, .capabilities-section .section-heading, .capabilities-section .body-copy",
          ),
          capabilitiesSection,
          { y: isDesktop ? 26 : 18 },
        );
      }
      if (capabilityList) {
        gsap.from(select(".capability-row"), {
          y: isDesktop ? 24 : 16,
          autoAlpha: 0,
          duration: 0.7,
          stagger: isDesktop ? 0.08 : 0.06,
          ease: "power2.out",
          overwrite: "auto",
          scrollTrigger: {
            trigger: capabilityList,
            start: "top 80%",
            toggleActions: ENTER,
          },
        });
      }

      // ---- Workflow: stages reveal + connector progression ----
      const workflowSection = first(".workflow-section");
      const workflowList = first(".workflow-list");
      if (workflowSection) {
        reveal(
          select(
            ".workflow-section .section-index, .workflow-section .section-heading",
          ),
          workflowSection,
        );
      }
      if (workflowList) {
        gsap.from(select(".workflow-stage"), {
          y: isDesktop ? 26 : 18,
          autoAlpha: 0,
          duration: 0.75,
          stagger: 0.1,
          ease: "power2.out",
          overwrite: "auto",
          scrollTrigger: {
            trigger: workflowList,
            start: "top 78%",
            toggleActions: ENTER,
          },
        });
        const connectors = select(".workflow-connector");
        if (connectors.length > 0) {
          gsap.fromTo(
            connectors,
            { scaleX: isDesktop ? 0 : 1, scaleY: isDesktop ? 1 : 0, opacity: 0.25 },
            {
              scaleX: 1,
              scaleY: 1,
              opacity: 1,
              ease: "none",
              transformOrigin: isDesktop ? "left center" : "center top",
              scrollTrigger: {
                trigger: workflowList,
                start: "top 72%",
                end: "bottom 55%",
                scrub: 0.5,
              },
            },
          );
        }
        const workflowNote = first(".workflow-note");
        if (workflowNote) reveal(workflowNote, workflowList, { start: "top 55%", y: 16 });
      }

      // ---- Future: deliberate look-ahead reveal ----
      const futureSection = first(".future-section");
      const futureList = first(".future-list");
      if (futureSection) {
        reveal(
          select(
            ".future-section .future-intro .section-index, .future-section .future-intro .section-heading, .future-section .future-intro .body-copy",
          ),
          futureSection,
          { y: isDesktop ? 30 : 18 },
        );
      }
      if (futureList) {
        gsap.from(select(".future-item"), {
          y: isDesktop ? 24 : 16,
          autoAlpha: 0,
          duration: 0.75,
          stagger: 0.08,
          ease: "power2.out",
          overwrite: "auto",
          scrollTrigger: {
            trigger: futureList,
            start: "top 80%",
            toggleActions: ENTER,
          },
        });
      }

      // ---- Final CTA: closing-scene entrance ----
      const closingSection = first(".closing-section");
      if (closingSection) {
        gsap.from(
          select(".closing-section .section-index, .closing-heading"),
          {
            y: isDesktop ? 42 : 28,
            autoAlpha: 0,
            duration: 1.1,
            stagger: 0.12,
            ease: EASE,
            overwrite: "auto",
            scrollTrigger: {
              trigger: closingSection,
              start: "top 75%",
              toggleActions: ENTER,
            },
          },
        );
        reveal(
          select(".closing-status, .closing-note, .closing-brand"),
          closingSection,
          { start: "top 60%", y: 16, stagger: 0.08 },
        );
        const closingRule = first(".closing-rule");
        if (closingRule) {
          gsap.from(closingRule, {
            scaleX: 0,
            transformOrigin: "left center",
            duration: 1.2,
            ease: "power2.inOut",
            overwrite: "auto",
            scrollTrigger: {
              trigger: closingSection,
              start: "top 55%",
              toggleActions: ENTER,
            },
          });
        }
      }
    },
    root,
  );

  const refreshAfterFonts =
    typeof document !== "undefined" && "fonts" in document
      ? document.fonts.ready.then(
          () => ScrollTrigger.refresh(),
          () => undefined,
        )
      : null;
  void refreshAfterFonts;

  const onLoad = () => ScrollTrigger.refresh();
  window.addEventListener("load", onLoad);
  disposers.push(() => window.removeEventListener("load", onLoad));

  requestAnimationFrame(() => ScrollTrigger.refresh());

  return () => {
    disposers.forEach((dispose) => dispose());
    mm.revert();
  };
}
