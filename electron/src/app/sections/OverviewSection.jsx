import { useEffect, useState } from "react";
import {
  ArrowUpRight,
  KeyRound,
  Mic,
  ScrollText,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.jsx";
import { Badge } from "@/components/ui/badge.jsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.jsx";
import { Separator } from "@/components/ui/separator.jsx";
import { Skeleton } from "@/components/ui/skeleton.jsx";
import useCredentials from "@/hooks/useCredentials.js";
import { PROVIDER_STATUS, statusMeta, summarizeCredentials } from "@/lib/provider-status.js";

function OverviewRow({ icon: Icon, title, detail, badge, sectionId, onNavigate, actionLabel }) {
  return (
    <li className="flex min-w-0 items-center gap-3 px-1 py-2.5">
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-foreground">{title}</span>
        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{detail}</span>
      </span>
      {badge ? <Badge variant={badge.variant}>{badge.label}</Badge> : null}
      <button
        type="button"
        onClick={() => onNavigate(sectionId)}
        className="flex shrink-0 items-center gap-1 rounded-sm text-[11px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {actionLabel} <ArrowUpRight className="size-3" aria-hidden />
      </button>
    </li>
  );
}

/**
 * Settings overview: one honest status per configuration area with
 * direct links. Read-only — every change happens in the owning
 * section, so this page can never drift from the source of truth.
 */
export default function OverviewSection({ onNavigate }) {
  const { credentials, loading: vaultLoading, error: vaultError } = useCredentials();
  const [tts, setTts] = useState({ credentialName: null, voice: null, model: null });
  const [ttsLoading, setTtsLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    window.api.getTtsConfig(null).catch(() => null).then((ttsRes) => {
      if (!alive) return;
      const config = ttsRes?.resolved ?? ttsRes?.config ?? null;
      setTts({
        credentialName: ttsRes?.credential?.name ?? null,
        voice: config?.voice ?? null,
        model: config?.model ?? null,
      });
      setTtsLoading(false);
    }).catch(() => {
      if (!alive) return;
      setTtsLoading(false);
    });
    return () => {
      alive = false;
    };
  }, []);

  const vision = summarizeCredentials(credentials);
  const visionBadge = statusMeta(vision.status, "vision");
  const ttsCount = credentials.filter((entry) => entry.purpose === "tts").length;
  const ttsVerified = credentials.some((entry) => entry.purpose === "tts" && entry.verification?.status === "verified");

  const loading = vaultLoading || ttsLoading;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 pb-8">
      <div className="min-w-0">
        <h1 className="text-[17px] font-semibold tracking-[-0.01em] text-foreground">Overview</h1>
        <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-muted-foreground">
          Configuration status at a glance. Paid runs need a verified vision provider; voice
          and prompt wording are layered on top.
        </p>
      </div>

      {vaultError ? (
        <Alert variant="destructive">
          <AlertTitle>Could not load provider status</AlertTitle>
          <AlertDescription>{vaultError}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>AI readiness</CardTitle>
          <CardDescription>What a new project can do right now.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {loading ? (
            <div className="flex flex-col gap-2" aria-label="Loading configuration status">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : (
            <ul className="flex flex-col divide-y divide-border">
              <OverviewRow
                icon={KeyRound}
                title="Vision providers"
                detail={
                  vision.total === 0
                    ? "No vision providers yet"
                    : `${vision.verifiedCount} of ${vision.total} verified for image input`
                }
                badge={vision.total === 0 ? statusMeta(PROVIDER_STATUS.NOT_CONNECTED) : visionBadge}
                sectionId="api-keys"
                onNavigate={onNavigate}
                actionLabel={vision.verifiedCount > 0 ? "Manage" : "Set up"}
              />
              <OverviewRow
                icon={Mic}
                title="Voice"
                detail={
                  ttsCount === 0
                    ? "No speech credentials — voice is optional"
                    : ttsVerified
                      ? `Checked · ${tts.voice ?? "default voice"}`
                      : "Speech credential saved, access not checked"
                }
                badge={ttsCount === 0 || !ttsVerified ? null : statusMeta(PROVIDER_STATUS.VISION_VERIFIED, "tts")}
                sectionId="tts-studio"
                onNavigate={onNavigate}
                actionLabel="Open voice"
              />
              <OverviewRow
                icon={ScrollText}
                title="Prompt packs"
                detail="Game-specific prompt wording"
                sectionId="prompt-packs"
                onNavigate={onNavigate}
                actionLabel="Inspect"
              />
            </ul>
          )}
        </CardContent>
      </Card>

      {!loading && vision.verifiedCount === 0 ? (
        <Alert>
          <AlertTitle>Vision is not ready yet</AlertTitle>
          <AlertDescription>
            Add a provider under AI Providers and run image verification. Projects cannot start
            paid analysis until one vision configuration is verified.
          </AlertDescription>
        </Alert>
      ) : null}

      <Separator />
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        All configuration lives on this device. Provider keys are encrypted with the OS
        keychain; only the requests you trigger leave the machine.
      </p>
    </div>
  );
}
