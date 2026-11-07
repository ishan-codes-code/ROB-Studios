import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, Gamepad2, LoaderCircle, ScanEye } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.jsx";
import { Badge } from "@/components/ui/badge.jsx";
import { Button } from "@/components/ui/button.jsx";
import { Separator } from "@/components/ui/separator.jsx";
import { Spinner } from "@/components/ui/spinner.jsx";
import GameMetadataForm, { gameRecordToInput } from "@/components/GameMetadataForm.jsx";
import { isRunReady } from "@/lib/config-display.js";
import { gameDisplayName } from "@/lib/games.js";

const selectClassName =
  "h-8 w-full rounded-sm border border-input bg-background px-2 text-[12px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

export function GroupHeading({ icon: Icon, title, actionLabel, onAction }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <h2 className="min-w-0 flex-1 truncate text-[11px] font-medium text-muted-foreground">
        {title}
      </h2>
      {actionLabel ? (
        <button
          type="button"
          onClick={onAction}
          className="flex shrink-0 items-center gap-1 rounded-sm text-[11px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {actionLabel} <ArrowUpRight className="size-3" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

function gameSummary(game) {
  const parts = [gameDisplayName(game?.id)];
  const meta = [game?.matchType, game?.mode, game?.map].filter(Boolean).join(" · ");
  if (meta) parts.push(meta);
  if (game?.language && game.language !== "English") parts.push(game.language);
  return parts.join(" · ");
}

/**
 * Compact project configuration overview for the editor Configure tab.
 * Three summary groups (AI vision, project-owned game metadata, prompt
 * pack) plus a readiness summary. Game metadata edits save explicitly
 * via the project channel; the prompt pack it flavors opens in its
 * settings section (workspace state is preserved) instead of a nested
 * management dialog.
 */
export default function ProjectConfiguration({ projectId, onReadinessChange, onNavigate }) {
  const [configuration, setConfiguration] = useState(null);
  const [credential, setCredential] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [credentials, setCredentials] = useState([]);
  const [packs, setPacks] = useState([]);
  const [defaultPackId, setDefaultPackId] = useState("free-fire");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState("");
  const [error, setError] = useState("");
  const [failedLists, setFailedLists] = useState([]);
  const [pendingGame, setPendingGame] = useState(null);
  const [gameSavedAt, setGameSavedAt] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setFailedLists([]);
    try {
      const [configRes, credRes, packsRes] = await Promise.all([
        window.api.getProjectConfig(projectId),
        window.api.listCredentials().catch(() => null),
        window.api.listPromptPacks().catch(() => null),
      ]);
      const failed = [];
      if (!credRes?.ok) failed.push("AI providers");
      setCredentials(credRes?.ok
        ? (credRes.credentials ?? []).filter((entry) => entry.purpose !== "tts")
        : []);
      if (packsRes?.ok) {
        setPacks(packsRes.packs ?? []);
        setDefaultPackId(packsRes.defaultPackId ?? "free-fire");
      }
      if (!configRes?.ok) throw new Error("Could not load the project configuration.");
      setConfiguration(configRes.configuration);
      setCredential(configRes.credential);
      setWarnings(configRes.warnings ?? []);
      setPendingGame(null);
      onReadinessChange?.(configRes.credential?.verified === true);
      if (failed.length > 0) setFailedLists(failed);
    } catch (err) {
      setError(err?.message ?? "Could not load the project configuration.");
      onReadinessChange?.(false);
    } finally {
      setLoading(false);
    }
  }, [onReadinessChange, projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const save = useCallback(async (field, value) => {
    setSaving(field);
    setError("");
    try {
      const result = await window.api.setProjectConfig(projectId, { [field]: value });
      if (!result?.ok) throw new Error("Could not save the project configuration.");
      const refreshed = await window.api.getProjectConfig(projectId);
      if (refreshed?.ok) {
        setConfiguration(refreshed.configuration);
        setCredential(refreshed.credential);
        setWarnings(refreshed.warnings ?? []);
        onReadinessChange?.(refreshed.credential?.verified === true);
      } else {
        setConfiguration(result.configuration);
      }
      if (field === "game") {
        setPendingGame(null);
        setGameSavedAt(Date.now());
      }
    } catch (err) {
      setError(err?.message ?? "Could not save the project configuration.");
    } finally {
      setSaving("");
    }
  }, [onReadinessChange, projectId]);

  const selectedPack = packs.find((entry) => entry.packId === (configuration?.promptPackId ?? defaultPackId)) ?? null;
  const savedCredentialMissing = (configuration?.credentialId ?? "") !== ""
    && !credentials.some((entry) => entry.id === configuration.credentialId);
  const ready = isRunReady({ credential, warnings });
  const gameDirty = pendingGame !== null
    && JSON.stringify(pendingGame) !== JSON.stringify(configuration?.game ?? null);

  const controlsDisabled = loading || saving !== "";

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {loading ? (
        <p role="status" className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Spinner /> Loading project configuration…
        </p>
      ) : null}
      {failedLists.length > 0 ? (
        <Alert variant="destructive">
          <AlertTitle>Some lists failed to load</AlertTitle>
          <AlertDescription>
            {`Could not load ${failedLists.join(", ")}. The lists below may be incomplete.`}
          </AlertDescription>
        </Alert>
      ) : null}

      <section className="flex min-w-0 flex-col gap-2" aria-label="AI vision">
        <GroupHeading icon={ScanEye} title="AI vision" actionLabel="Manage providers" onAction={() => onNavigate?.("api-keys")} />
        <select
          aria-label="Vision provider"
          className={selectClassName}
          value={configuration?.credentialId ?? ""}
          disabled={controlsDisabled}
          onChange={(event) => save("credentialId", event.target.value === "" ? null : event.target.value)}
        >
          <option value="">Select a provider…</option>
          {savedCredentialMissing ? (
            <option value={configuration.credentialId}>
              {credential ? `${credential.name} · ${credential.model}` : configuration.credentialId}
              {" · unavailable — pick a replacement"}
            </option>
          ) : null}
          {credentials.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name} · {entry.model}
              {entry.verification?.status === "verified" ? " · verified" : " · unverified"}
            </option>
          ))}
        </select>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Badge variant={credential?.verified ? "secondary" : "outline"}>
            {credential ? (credential.verified ? "Vision verified" : "Unverified") : "No provider"}
          </Badge>
          {credential ? (
            <span className="truncate font-mono text-[10px] tabular-nums text-muted-foreground">
              {credential.provider} · {credential.model}
            </span>
          ) : (
            <span className="text-[11px] text-muted-foreground">
              {credentials.length === 0 && !failedLists.includes("AI providers")
                ? "No providers yet — add one to begin."
                : "Choose a provider for this project."}
            </span>
          )}
        </div>
      </section>

      <Separator />

      <section className="flex min-w-0 flex-col gap-2" aria-label="Game">
        <GroupHeading icon={Gamepad2} title="Game" />
        <p className="truncate text-[12px] text-foreground" title={gameSummary(configuration?.game)}>
          {gameSummary(configuration?.game)}
        </p>
        <details className="group min-w-0">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 rounded-sm text-[11px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            Edit match details
          </summary>
          <div className="flex min-w-0 flex-col gap-2 pt-2">
            <GameMetadataForm
              key={`${projectId}-${gameSavedAt}`}
              initial={gameRecordToInput(configuration?.game)}
              disabled={controlsDisabled}
              onChange={setPendingGame}
            />
            <div>
              <Button
                type="button"
                size="sm"
                disabled={controlsDisabled || !gameDirty}
                onClick={() => pendingGame && save("game", pendingGame)}
              >
                Save game details
              </Button>
            </div>
          </div>
        </details>
        <select
          aria-label="Prompt pack"
          className={selectClassName}
          value={configuration?.promptPackId ?? ""}
          disabled={controlsDisabled || packs.length === 0}
          onChange={(event) => save("promptPackId", event.target.value === "" ? null : event.target.value)}
        >
          <option value="">Prompt pack: application default</option>
          {packs.map((entry) => (
            <option key={entry.packId} value={entry.packId}>
              Prompt pack: {entry.displayName}
              {entry.packId === defaultPackId ? " · default" : ""}
              {entry.customized.length > 0 ? ` · ${entry.customized.length} customized` : ""}
            </option>
          ))}
        </select>
        {selectedPack ? (
          <button
            type="button"
            onClick={() => onNavigate?.("prompt-packs")}
            className="flex items-center gap-1 self-start rounded-sm text-[11px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Inspect prompt wording <ArrowUpRight className="size-3" aria-hidden />
          </button>
        ) : null}
      </section>

      <Separator />

      <section className="flex min-w-0 flex-col gap-1.5" aria-label="Configuration readiness">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[12px] font-medium text-foreground">Ready to process</span>
          <Badge variant={ready ? "secondary" : "outline"}>{ready ? "Ready" : "Not ready"}</Badge>
        </div>
        {!ready && !loading ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {credential
              ? (credential.verified
                ? "Resolve the warnings below to start a run."
                : "Run image verification for the selected provider to start paid analysis.")
              : "Select a verified vision provider to start paid analysis."}
          </p>
        ) : null}
      </section>

      {saving ? (
        <p role="status" className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <LoaderCircle className="size-3.5 animate-spin" /> Saving…
        </p>
      ) : null}
      {warnings.length > 0 ? (
        <Alert>
          <AlertTitle>Configuration needs attention</AlertTitle>
          <AlertDescription>
            <ul className="flex flex-col gap-1">
              {warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Could not save</AlertTitle>
          <AlertDescription className="min-w-0 [overflow-wrap:anywhere]">{error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
