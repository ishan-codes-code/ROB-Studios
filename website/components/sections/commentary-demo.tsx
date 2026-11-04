"use client";
import { useState } from "react";
import { DEMO_EVENTS } from "@/lib/sample-data";

const STAGES = ["Gameplay", "Visual understanding", "Match context", "Commentary"] as const;

export default function CommentaryDemo() {
  const [activeId, setActiveId] = useState(DEMO_EVENTS[0].id);
  const active = DEMO_EVENTS.find((e) => e.id === activeId) ?? DEMO_EVENTS[0];
  return (
    <section id="demo" aria-labelledby="demo-title" className="story-section demo-section scroll-mt-8">
      <div className="section-shell scene-surface">
        <p className="section-index">04 — From gameplay to commentary</p>
        <h2 id="demo-title" className="section-heading mt-5 max-w-xl">Pixels in. A story out.</h2>
        <p className="body-copy mt-6 max-w-xl">Four connected stages, shown with clearly labelled illustrative content. Select a sample moment to see how observation becomes a line.</p>

        <div className="demo-tabs" role="tablist" aria-label="Illustrative gameplay events">
          {DEMO_EVENTS.map((e) => (
            <button key={e.id} role="tab" aria-selected={e.id === activeId} onClick={() => setActiveId(e.id)} className="demo-tab" data-active={e.id === activeId}>
              <span className="font-mono text-[10px] text-zinc-500">{e.time}</span> {e.label}
            </button>
          ))}
        </div>

        <div className="demo-pipeline" aria-live="polite">
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
          <div className="demo-wave" aria-hidden="true">{Array.from({ length: 32 }).map((_, i) => <span key={i} style={{ height: `${6 + Math.abs(Math.sin(i * 1.7)) * 18}px` }} />)}</div>
          <p className="font-mono text-[10px] tracking-[0.14em] text-zinc-500">{active.confidence.toUpperCase()} · AUDIO WAVEFORM PLACEHOLDER · ALL OUTPUT ILLUSTRATIVE DEMO CONTENT</p>
        </div>
      </div>
    </section>
  );
}
