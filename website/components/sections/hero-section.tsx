import { ChevronDown } from "lucide-react";
import FlowField from "@/components/kokonutui/flow-field";
import GlitchText from "@/components/kokonutui/glitch-text";

export default function HeroSection() {
  return (
    <section
      aria-labelledby="hero-title"
      className="hero-section relative isolate flex min-h-svh items-center justify-center overflow-hidden bg-void px-6 text-center"
    >
      <FlowField
        density={0.5}
        speed={0.38}
        interactive
        className="hero-flow absolute inset-0"
      />
      <div aria-hidden="true" className="hero-vignette absolute inset-0" />

      <div className="relative z-10 mx-auto flex w-full max-w-6xl flex-col items-center pb-16 pt-24">
        <p className="hero-kicker mb-8 flex items-center gap-3 text-[10px] font-medium uppercase tracking-[0.34em] text-white/55 sm:text-xs">
          <span aria-hidden="true" className="h-px w-8 bg-white/35" />
          AI Commentator
          <span aria-hidden="true" className="h-px w-8 bg-white/35" />
        </p>

        <h1 id="hero-title" className="hero-title max-w-5xl font-semibold">
          <GlitchText
            as="span"
            text="Every game has a story."
            trigger="idle"
            intensity="subtle"
            className="hero-glitch block"
          />
          <span className="hero-title-second block">Give it a voice.</span>
        </h1>

        <p className="mt-7 max-w-xl text-sm leading-7 text-white/65 sm:text-base sm:leading-8">
          An intelligent commentary engine that turns gameplay into a story
          worth watching.
        </p>
      </div>

      <a
        className="hero-explore absolute bottom-7 left-1/2 z-20 inline-flex min-h-12 -translate-x-1/2 flex-col items-center justify-center gap-2 px-5 text-[10px] font-medium uppercase tracking-[0.25em] text-white/75 transition-colors hover:text-white focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white sm:bottom-10"
        href="#introduction"
      >
        <span>Explore the engine</span>
        <ChevronDown aria-hidden="true" className="size-4" strokeWidth={1.5} />
      </a>
    </section>
  );
}
