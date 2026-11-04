import { Badge } from "@/components/ui/badge.jsx";
import esportsSetupUrl from "@/assets/images/esports-setup.webp";

/**
 * Cinematic dashboard centerpiece for the future live-commentary
 * capability. Informational only: no actions, no links, no fake
 * metrics, no implied availability — deliberately not clickable.
 * The photograph renders grayscale with a strong black readability
 * gradient; no animation, so reduced-motion needs no special case.
 *
 * Focal math: at banner aspect ratios the cover fit shows the full
 * image width but only ~35% of its height. A 38% vertical anchor
 * keeps both the gamer's headset and the match monitor in frame.
 */
export default function LiveCommentaryHero() {
  return (
    <section
      aria-labelledby="live-commentary-title"
      className="relative h-[300px] min-w-0 cursor-default overflow-hidden rounded-panel border border-border sm:h-[250px]"
    >
      <img
        src={esportsSetupUrl}
        alt=""
        aria-hidden
        draggable={false}
        decoding="async"
        className="absolute inset-0 h-full w-full object-cover object-[50%_38%] grayscale"
      />
      <div
        aria-hidden
        className="absolute inset-0 bg-gradient-to-r from-black via-black/80 to-black/30"
      />
      <div className="relative flex h-full min-w-0 max-w-xl flex-col items-start justify-center gap-2.5 p-6 md:p-8">
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-foreground">
            Live commentary
          </p>
          <Badge
            variant="outline"
            className="border-border bg-black/40 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
          >
            Coming soon
          </Badge>
        </div>
        <h2
          id="live-commentary-title"
          className="text-[26px] font-bold leading-[1.1] tracking-[-0.02em] text-foreground md:text-[30px]"
        >
          Every moment. Every play. Live.
        </h2>
        <p className="max-w-md text-[13px] leading-relaxed text-muted-foreground">
          Real-time gameplay understanding, match memory and
          broadcast-ready AI voice commentary.
        </p>
      </div>
    </section>
  );
}
