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
      const heroSection = first(".hero-section");
      const heroContent = first(".hero-section .max-w-6xl");
      const heroFlow = first(".hero-flow");
      gsap
        .timeline({ defaults: { ease: EASE } })
        .from(select(".hero-kicker"), { y: 16, autoAlpha: 0, duration: 0.8 }, 0.15)
        .from(
          select(".hero-title-second"),
          { y: isDesktop ? 44 : 30, autoAlpha: 0, duration: 1.15 },
          0.28,
        )
        .from(select(".hero-title + p"), { y: 24, autoAlpha: 0, duration: 0.9 }, 0.5)
        .from(select(".hero-explore"), { y: 12, autoAlpha: 0, duration: 0.7 }, 0.7);

      // ---- Hero: scroll-linked exit while the introduction covers it ----
      if (heroSection && heroContent) {
        gsap.to(heroContent, {
          y: isDesktop ? -90 : -56,
          scale: isDesktop ? 0.97 : 1,
          autoAlpha: 0,
          ease: "none",
          transformOrigin: "center top",
          scrollTrigger: {
            trigger: heroSection,
            start: "top top",
            end: "bottom top",
            scrub: isDesktop ? 0.6 : 0.4,
          },
        });
      }
      if (heroSection && heroFlow) {
        gsap.to(heroFlow, {
          yPercent: isDesktop ? 14 : 8,
          opacity: 0.35,
          ease: "none",
          scrollTrigger: {
            trigger: heroSection,
            start: "top top",
            end: "bottom top",
            scrub: isDesktop ? 0.6 : 0.4,
          },
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
          if (isDesktop) {
            gsap.to(introSignal, {
              y: -30,
              ease: "none",
              scrollTrigger: {
                trigger: introSection,
                start: "top bottom",
                end: "bottom top",
                scrub: 0.6,
              },
            });
          }
        }
      }

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
