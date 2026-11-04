"use client";
import { useRef, useState } from "react";
import { DEMO_EVENTS } from "@/lib/sample-data";

const STAGES = ["Gameplay", "Visual understanding", "Match context", "Commentary"] as const;
// Integer heights, identical on server and client. A raw float here
// serializes differently in SSR HTML vs. client hydration (React #418
// hydration-mismatch on the style attribute).
const WAVEFORM_HEIGHTS = Array.from({ length: 32 }, (_, i) =>
  Math.round(6 + Math.abs(Math.sin(i * 1.7)) * 18)
);

export default function CommentaryDemo() {
  const [activeId, setActiveId] = useState(DEMO_EVENTS[0].id);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeIndex = DEMO_EVENTS.findIndex((e) => e.id === activeId);
  const active = DEMO_EVENTS[activeIndex] ?? DEMO_EVENTS[0];

  const select = (index: number, focus = false) => {
    const event = DEMO_EVENTS[(index + DEMO_EVENTS.length) % DEMO_EVENTS.length];
    setActiveId(event.id);
    if (focus) tabRefs.current[DEMO_EVENTS.indexOf(event)]?.focus();
  };

  const onTabKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight") { e.preventDefault(); select(activeIndex + 1, true); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); select(activeIndex - 1, true); }
    else if (e.key === "Home") { e.preventDefault(); select(0, true); }
    else if (e.key === "End") { e.preventDefault(); select(DEMO_EVENTS.length - 1, true); }
  };

  return (
    <section id="demo" aria-labelledby="demo-title" className="story-section demo-section scroll-mt-8">
      <div className="section-shell scene-surface">
        <p className="section-index">04 — From gameplay to commentary</p>
        <h2 id="demo-title" className="section-heading mt-5 max-w-xl">Pixels in. A story out.</h2>
        <p className="body-copy mt-6 max-w-xl">Four connected stages, shown with clearly labelled illustrative content. Select a sample moment to see how observation becomes a line.</p>

        <div className="demo-tabs" role="tablist" aria-label="Illustrative gameplay events" onKeyDown={onTabKeyDown}>
          {DEMO_EVENTS.map((e, i) => (
            <button key={e.id} ref={(el) => { tabRefs.current[i] = el; }} id={`demo-tab-${e.id}`} role="tab" aria-selected={e.id === activeId} aria-controls="demo-panel" tabIndex={e.id === activeId ? 0 : -1} onClick={() => setActiveId(e.id)} className="demo-tab" data-active={e.id === activeId}>
              <span className="font-mono text-[10px] text-zinc-500">{e.time}</span> {e.label}
            </button>
          ))}
        </div>

        <div id="demo-panel" role="tabpanel" aria-labelledby={`demo-tab-${active.id}`} className="demo-pipeline" aria-live="polite">
          {STAGES.map((stage, i) => (
            <div key={stage} className="demo-stage">
              <p className="font-mono text-[10px] tracking-[0.2em] text-zinc-500">0{i + 1} · {stage.toUpperCase()}</p>
              <div className="demo-stage-body">
                {i === 0 && <p>{active.label} — sample frame at {active.time}.<span className="demo-tag">Illustrative</span></p>}
                {i === 1 && <p>{active.observation}</p>}
                {i === 2 && <p>{active.context}</p>}
                {i === 3 && <p className="text-white">&ldquo;{active.commentary}&rdquo;</p>}
              </div>
              {i < STAGES.length - 1 && <span className="demo-connector" aria-hidden="true" />}
            </div>
          ))}
        </div>

        <div className="demo-footer">
          <div className="demo-wave" aria-hidden="true">{WAVEFORM_HEIGHTS.map((height, i) => <span key={i} style={{ height: `${height}px` }} />)}</div>
          <p className="font-mono text-[10px] tracking-[0.14em] text-zinc-500">{active.confidence.toUpperCase()} · AUDIO WAVEFORM PLACEHOLDER · ALL OUTPUT ILLUSTRATIVE DEMO CONTENT</p>
        </div>
      </div>
    </section>
  );
}
