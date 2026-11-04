"use client";
import { useState } from "react";
import { Pause, Play } from "lucide-react";

export default function GameplayShowcase({ mediaSrc }: { mediaSrc?: string }) {
  const [playing, setPlaying] = useState(false);
  return (
    <section id="showcase" aria-labelledby="showcase-title" className="story-section showcase-section scroll-mt-8">
      <div className="section-shell scene-surface">
        <div className="mb-10 flex flex-wrap items-end justify-between gap-6 showcase-head">
          <div>
            <p className="section-index">03 — Gameplay showcase</p>
            <h2 id="showcase-title" className="section-heading mt-5">See the match the way the engine sees it.</h2>
          </div>
          <p className="body-copy max-w-sm">A cinematic viewport for the kind of gameplay AI Commentator is built to interpret. Real footage will replace this placeholder.</p>
        </div>

        <div className="showcase-frame" data-playing={playing}>
          <div className="showcase-topbar">
            <span className="font-mono text-[10px] tracking-[0.18em] text-zinc-500">SAMPLE FEED · DEMO</span>
            <span className="font-mono text-[10px] tracking-[0.18em] text-zinc-400">18:42 / 32:10</span>
            <span className="flex items-center gap-2 font-mono text-[10px] tracking-[0.18em] text-zinc-500"><span className="size-1.5 rounded-full bg-white" />1080p · PLACEHOLDER</span>
          </div>
          <div className="showcase-viewport">
            {mediaSrc ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={mediaSrc} alt="Gameplay footage preview" className="absolute inset-0 h-full w-full object-cover grayscale" />
            ) : (
              <div className="showcase-placeholder" aria-label="Demo footage placeholder awaiting real gameplay">
                <div className="showcase-grid" aria-hidden="true" />
                <div className="showcase-horizon" aria-hidden="true" />
                <div className="showcase-silhouette" aria-hidden="true"><span /><span /><span /></div>
                <p className="font-mono text-[10px] tracking-[0.3em] text-zinc-500">DEMO FOOTAGE PLACEHOLDER</p>
                <p className="mt-3 max-w-xs text-center text-sm leading-6 text-zinc-400">Cinematic placeholder — replace <span className="font-mono text-zinc-300">mediaSrc</span> with real gameplay footage.</p>
              </div>
            )}
            <div className="showcase-scanline" aria-hidden="true" />
          </div>
          <div className="showcase-controls">
            <button type="button" onClick={() => setPlaying((v) => !v)} aria-pressed={playing} aria-label={playing ? "Pause placeholder playback" : "Play placeholder playback"} className="showcase-play">
              {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
            </button>
            <div className="showcase-track" aria-hidden="true"><span style={{ width: playing ? "58%" : "42%" }} /></div>
            <span className="font-mono text-[10px] text-zinc-500">{playing ? "PREVIEW PLAYING · VISUAL ONLY" : "PREVIEW PAUSED"}</span>
          </div>
        </div>
        <p className="mt-6 max-w-2xl text-sm leading-7 text-zinc-400 showcase-caption">Late-game ridge pressure: two opponents advancing on high ground while the player holds low cover. This is the raw material — frames the engine samples, reads, and turns into context.</p>
      </div>
    </section>
  );
}
