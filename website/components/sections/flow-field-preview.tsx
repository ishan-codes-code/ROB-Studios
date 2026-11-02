"use client";

import FlowField from "@/components/kokonutui/flow-field";

export default function FlowFieldPreview() {
  return (
    <section className="relative flex min-h-[600px] items-center justify-center overflow-hidden bg-[#080808]">
      <FlowField
        density={0.65}
        speed={0.45}
        interactive={true}
        className="absolute inset-0"
      />

      <div className="pointer-events-none relative z-10 mx-auto max-w-4xl px-6 text-center">
        <p className="mb-6 text-xs font-medium uppercase tracking-[0.35em] text-neutral-400">
          AI-Powered Gaming Commentary
        </p>

        <h1 className="text-5xl font-semibold tracking-tight text-white md:text-7xl">
          Every game has a story.
          <span className="mt-2 block text-neutral-400">
            Give it a voice.
          </span>
        </h1>

        <p className="mx-auto mt-8 max-w-xl text-base leading-7 text-neutral-400 md:text-lg">
          Transform gameplay into intelligent commentary.
          Every moment deserves to be understood.
        </p>
      </div>
    </section>
  );
}