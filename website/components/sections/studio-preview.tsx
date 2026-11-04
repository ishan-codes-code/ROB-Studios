"use client";
import { useState } from "react";

const PANELS = ["Overview", "Observations", "Timeline"] as const;

export default function StudioPreview({ screenshotSrc }: { screenshotSrc?: string }) {
  const [panel, setPanel] = useState<(typeof PANELS)[number]>("Overview");
  return (
    <section id="studio" aria-labelledby="studio-title" className="story-section studio-section scroll-mt-8">
      <div className="section-shell scene-surface">
        <div className="mb-10 flex flex-wrap items-end justify-between gap-6">
          <div>
            <p className="section-index">07 — Commentary Studio</p>
            <h2 id="studio-title" className="section-heading mt-5">Where matches become broadcasts.</h2>
          </div>
          <p className="body-copy max-w-sm">The desktop workspace: bring in footage, run analysis, inspect every observation before it becomes commentary.</p>
        </div>

        <div className="studio-frame">
          <div className="studio-titlebar">
            <span className="flex gap-1.5" aria-hidden="true"><i /><i /><i /></span>
            <span className="font-mono text-[10px] tracking-[0.18em] text-zinc-500">AI COMMENTATOR — COMMENTARY STUDIO</span>
            <span className="font-mono text-[10px] text-zinc-600">STUDIO PREVIEW — PLACEHOLDER</span>
          </div>
          {screenshotSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={screenshotSrc} alt="Commentary Studio application screenshot" className="w-full" />
          ) : (
            <div className="studio-body">
              <aside className="studio-sidebar">
                <p className="font-mono text-[10px] tracking-[0.2em] text-zinc-500">PROJECT</p>
                <p className="mt-3 text-sm text-white">Ridge Finals — Sample</p>
                <p className="font-mono text-[10px] text-zinc-600">DEMO PROJECT · PLACEHOLDER</p>
                <nav className="mt-8 flex flex-col gap-1" aria-label="Studio preview panels">
                  {PANELS.map((p) => (
                    <button key={p} onClick={() => setPanel(p)} aria-pressed={panel === p} className="studio-nav" data-active={panel === p}>{p}</button>
                  ))}
                </nav>
                <div className="mt-auto border-t border-[#242424] pt-4 font-mono text-[10px] leading-5 text-zinc-600">FOOTAGE<br />ANALYSIS<br />SCRIPT</div>
              </aside>
              <div className="studio-main">
                <div className="studio-viewport">
                  <p className="font-mono text-[10px] tracking-[0.25em] text-zinc-500">GAMEPLAY PREVIEW</p>
                  <p className="mt-2 text-xs text-zinc-500">Illustrative mock — replace with a real Studio screenshot via <span className="font-mono text-zinc-300">screenshotSrc</span>.</p>
                </div>
                <div className="studio-lower">
                  <div className="studio-card">
                    <p className="font-mono text-[10px] tracking-[0.18em] text-zinc-500">{panel.toUpperCase()}</p>
                    {panel === "Overview" && <p className="mt-3 text-sm leading-6 text-zinc-300">Sample match loaded. Vision analysis and commentary script appear here as artifacts.</p>}
                    {panel === "Observations" && <p className="mt-3 text-sm leading-6 text-zinc-300">Validated observations with quoted evidence. Unsupported claims stay suppressed.</p>}
                    {panel === "Timeline" && <p className="mt-3 text-sm leading-6 text-zinc-300">Commentary lines placed against match time. Voice output is in development.</p>}
                  </div>
                  <div className="studio-card">
                    <p className="font-mono text-[10px] tracking-[0.18em] text-zinc-500">COMMENTARY TIMELINE · ILLUSTRATIVE</p>
                    <div className="mt-4 space-y-3" aria-hidden="true">
                      <div className="studio-line" style={{ width: "72%" }} /><div className="studio-line" style={{ width: "48%" }} /><div className="studio-line" style={{ width: "64%" }} />
                    </div>
                    <p className="mt-4 text-xs leading-5 text-zinc-500">&ldquo;Two opponents are closing in from the ridge…&rdquo; — illustrative line, not a real analysis.</p>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
        <p className="mt-5 font-mono text-[10px] tracking-[0.14em] text-zinc-600">ILLUSTRATIVE UI COMPOSITION IN THE PRODUCT DESIGN LANGUAGE · NO UNIMPLEMENTED FUNCTIONALITY IMPLIED</p>
      </div>
    </section>
  );
}
