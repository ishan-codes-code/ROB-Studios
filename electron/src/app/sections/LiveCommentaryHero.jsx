import { Badge } from "@/components/ui/badge.jsx";
import esportsSetupUrl from "@/assets/images/esports-setup.webp";

/**
 * Dominant dashboard announcement for the future live-commentary
 * capability. Informational only: no actions, no links, no fake
 * metrics, no implied availability — deliberately not clickable.
 * One static photograph with a readability gradient and a single
 * token-derived violet wash; no animation, so reduced-motion needs
 * no special case.
 */
export default function LiveCommentaryHero() {
  return (
    <section
      aria-labelledby="live-commentary-title"
      className="relative min-w-0 cursor-default overflow-hidden rounded-panel border border-border"
    >
      <img
        src={esportsSetupUrl}
        alt=""
        aria-hidden
        draggable={false}
        decoding="async"
        className="absolute inset-0 h-full w-full object-cover object-center"
      />
      <div
        aria-hidden
        className="absolute inset-0 bg-gradient-to-r from-background via-background/85 to-background/25"
      />
      <div
        aria-hidden
        className="absolute inset-0 bg-[radial-gradient(420px_180px_at_88%_15%,color-mix(in_srgb,var(--live)_16%,transparent),transparent)]"
      />
      <div className="relative flex min-w-0 flex-col items-start gap-2 p-5 md:max-w-xl md:p-6">
        <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-live">
          Live commentary
        </p>
        <Badge variant="outline" className="border-border bg-background/60">
          Coming soon
        </Badge>
        <h2
          id="live-commentary-title"
          className="text-[17px] font-semibold leading-tight tracking-[-0.01em] text-foreground"
        >
          The next generation of live game commentary
        </h2>
        <p className="max-w-md text-[13px] leading-relaxed text-muted-foreground">
          Real-time gameplay understanding, match memory and
          broadcast-ready AI voice commentary.
        </p>
      </div>
    </section>
  );
}
