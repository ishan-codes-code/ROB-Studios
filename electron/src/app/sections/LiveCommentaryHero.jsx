import { Brain, Mic, Radio } from "lucide-react";
import { Badge } from "@/components/ui/badge.jsx";
import GlassCard from "@/primitives/GlassCard.jsx";

const CAPABILITIES = [
  {
    icon: Radio,
    title: "Live gameplay analysis",
    text: "Watches the match as it happens.",
  },
  {
    icon: Brain,
    title: "Context-aware match intelligence",
    text: "Reads momentum, comebacks, and turning points.",
  },
  {
    icon: Mic,
    title: "Real-time AI voice commentary",
    text: "Broadcast-ready voice, delivered live.",
  },
];

/**
 * Dominant dashboard announcement for the future live-commentary
 * capability. Informational only: no actions, no fake metrics, no
 * implied availability. One static token-derived ambient wash at
 * most; no animation, so reduced-motion needs no special case.
 */
export default function LiveCommentaryHero() {
  return (
    <GlassCard className="bg-[radial-gradient(560px_180px_at_15%_0%,color-mix(in_srgb,var(--primary)_6%,transparent),transparent)]">
      <section
        aria-labelledby="live-commentary-title"
        className="flex min-w-0 flex-col gap-4 p-5 md:flex-row md:gap-6"
      >
        <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
          <Badge variant="outline">Coming soon</Badge>
          <h2
            id="live-commentary-title"
            className="text-[17px] font-semibold uppercase leading-tight tracking-[0.04em] text-foreground"
          >
            Live AI commentary
          </h2>
          <p className="text-[13px] font-medium text-foreground">
            Every moment. Every play. Live.
          </p>
          <p className="max-w-xl text-[13px] leading-relaxed text-muted-foreground">
            Go beyond recorded gameplay. AI Commentator is evolving to
            understand live gameplay as it happens, recognize match
            events and deliver real-time, broadcast-ready voice
            commentary.
          </p>
        </div>
        <ul className="flex min-w-0 flex-col gap-3 border-t border-border pt-4 md:w-72 md:shrink-0 md:border-l md:border-t-0 md:pl-6 md:pt-0">
          {CAPABILITIES.map(({ icon: Icon, title, text }) => (
            <li key={title} className="flex min-w-0 items-start gap-2.5">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-sm bg-accent text-muted-foreground">
                <Icon className="size-4" aria-hidden />
              </span>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[13px] font-medium leading-snug text-foreground">
                  {title}
                </span>
                <span className="text-xs leading-relaxed text-muted-foreground">
                  {text}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </GlassCard>
  );
}
