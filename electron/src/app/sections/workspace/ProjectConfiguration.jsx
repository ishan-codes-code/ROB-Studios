import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, Gamepad2, LoaderCircle, MessageSquareText, ScanEye } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.jsx";
import { Badge } from "@/components/ui/badge.jsx";
import { Button } from "@/components/ui/button.jsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.jsx";
import { Separator } from "@/components/ui/separator.jsx";
import { Spinner } from "@/components/ui/spinner.jsx";
import { isRunReady, presetsForProfile } from "@/lib/config-display.js";

// Radix items require non-empty values, so meaningful "empty" choices
// use explicit sentinels mapped back to null on commit.
const NONE_VALUE = "__none";
const DEFAULT_PACK_VALUE = "__default";

function FieldSelect({ ariaLabel, value, onValueChange, disabled, placeholder, children }) {
  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger aria-label={ariaLabel} size="sm" className="w-full rounded-sm text-[12px]">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>{children}</SelectContent>
    </Select>
  );
}

function GroupHeading({ icon: Icon, title, actionLabel, onAction }) {
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

/**
 * Compact project configuration overview for the editor Configure tab.
 * Three summary groups (AI vision, game profile, commentary style —
 * the prompt pack selector lives with the game profile it flavors)
 * plus a readiness summary. Project selections stay project-scoped;
 * global resources open in their settings sections (workspace state is
 * preserved) instead of nested management dialogs.
 */
export default function ProjectConfiguration({ projectId, onReadinessChange, onNavigate }) {
  const [configuration, setConfiguration] = useState(null);
  const [credential, setCredential] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [credentials, setCredentials] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [presets, setPresets] = useState([]);
  const [packs, setPacks] = useState([]);
  const [defaultPackId, setDefaultPackId] = useState("free-fire");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState("");
  const [error, setError] = useState("");
  const [failedLists, setFailedLists] = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setFailedLists([]);
    try {
      const [configRes, credRes, profileRes, presetRes, packsRes] = await Promise.all([
        window.api.getProjectConfig(projectId),
        window.api.listCredentials().catch(() => null),
        window.api.listGameProfiles().catch(() => null),
        window.api.listPresets(null).catch(() => null),
        window.api.listPromptPacks().catch(() => null),
      ]);
      const failed = [];
      if (!credRes?.ok) failed.push("AI providers");
      if (!profileRes?.ok) failed.push("game profiles");
      if (!presetRes?.ok) failed.push("commentary presets");
      setCredentials(credRes?.ok
        ? (credRes.credentials ?? []).filter((entry) => entry.purpose !== "tts")
        : []);
      setProfiles(profileRes?.ok ? (profileRes.profiles ?? []) : []);
      setPresets(presetRes?.ok ? (presetRes.presets ?? []) : []);
      if (packsRes?.ok) {
        setPacks(packsRes.packs ?? []);
        setDefaultPackId(packsRes.defaultPackId ?? "free-fire");
      }
      if (!configRes?.ok) throw new Error("Could not load the project configuration.");
      setConfiguration(configRes.configuration);
      setCredential(configRes.credential);
      setWarnings(configRes.warnings ?? []);
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
    } catch (err) {
      setError(err?.message ?? "Could not save the project configuration.");
    } finally {
      setSaving("");
    }
  }, [onReadinessChange, projectId]);

  const selectedProfile = profiles.find((entry) => entry.id === configuration?.gameProfileId) ?? null;
  const profilePresets = presetsForProfile(presets, configuration?.gameProfileId);
  const selectedPreset = profilePresets.find((entry) => entry.id === configuration?.commentaryPresetId) ?? null;
  const selectedPack = packs.find((entry) => entry.packId === (configuration?.promptPackId ?? defaultPackId)) ?? null;
  const savedCredentialMissing = (configuration?.credentialId ?? "") !== ""
    && !credentials.some((entry) => entry.id === configuration.credentialId);
  const ready = isRunReady({ credential, warnings });

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
        <FieldSelect
          ariaLabel="Vision provider"
          value={configuration?.credentialId ?? NONE_VALUE}
          disabled={controlsDisabled}
          placeholder="Select a provider…"
          onValueChange={(next) => save("credentialId", next === NONE_VALUE ? null : next)}
        >
          <SelectItem value={NONE_VALUE}>Select a provider…</SelectItem>
          {savedCredentialMissing ? (
            <SelectItem value={configuration.credentialId}>
              {credential ? `${credential.name} · ${credential.model}` : configuration.credentialId}
              {" · unavailable — pick a replacement"}
            </SelectItem>
          ) : null}
          {credentials.map((entry) => (
            <SelectItem key={entry.id} value={entry.id}>
              {entry.name} · {entry.model}
              {entry.verification?.status === "verified" ? " · verified" : " · unverified"}
            </SelectItem>
          ))}
        </FieldSelect>
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

      <section className="flex min-w-0 flex-col gap-2" aria-label="Game profile">
        <GroupHeading icon={Gamepad2} title="Game profile" actionLabel="Manage games" onAction={() => onNavigate?.("game-profiles")} />
        <FieldSelect
          ariaLabel="Game profile"
          value={configuration?.gameProfileId ?? "free-fire-default"}
          disabled={controlsDisabled}
          onValueChange={(next) => save("gameProfileId", next)}
        >
          {profiles.map((entry) => (
            <SelectItem key={entry.id} value={entry.id}>
              {entry.name}
              {entry.builtIn ? "" : " · custom"}
            </SelectItem>
          ))}
        </FieldSelect>
        {selectedProfile?.context ? (
          <p className="truncate text-[11px] text-muted-foreground" title={selectedProfile.context}>
            {selectedProfile.context}
          </p>
        ) : null}
        <FieldSelect
          ariaLabel="Prompt pack"
          value={configuration?.promptPackId ?? DEFAULT_PACK_VALUE}
          disabled={controlsDisabled || packs.length === 0}
          onValueChange={(next) => save("promptPackId", next === DEFAULT_PACK_VALUE ? null : next)}
        >
          <SelectItem value={DEFAULT_PACK_VALUE}>Prompt pack: application default</SelectItem>
          {packs.map((entry) => (
            <SelectItem key={entry.packId} value={entry.packId}>
              Prompt pack: {entry.displayName}
              {entry.packId === defaultPackId ? " · default" : ""}
              {entry.customized.length > 0 ? ` · ${entry.customized.length} customized` : ""}
            </SelectItem>
          ))}
        </FieldSelect>
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

      <section className="flex min-w-0 flex-col gap-2" aria-label="Commentary style">
        <GroupHeading icon={MessageSquareText} title="Commentary style" actionLabel="Manage styles" onAction={() => onNavigate?.("commentary-presets")} />
        <FieldSelect
          ariaLabel="Commentary preset"
          value={configuration?.commentaryPresetId ?? "default-energetic"}
          disabled={controlsDisabled}
          onValueChange={(next) => save("commentaryPresetId", next)}
        >
          {profilePresets.map((entry) => (
            <SelectItem key={entry.id} value={entry.id}>
              {entry.name}
              {[entry.tone, entry.language].filter(Boolean).join(" · ")
                ? ` · ${[entry.tone, entry.language].filter(Boolean).join(" · ")}`
                : ""}
            </SelectItem>
          ))}
        </FieldSelect>
        <p className="truncate text-[11px] text-muted-foreground">
          {selectedPreset
            ? ([selectedPreset.personality, selectedPreset.tone, selectedPreset.language].filter(Boolean).join(" · ") || "Default style")
            : "The saved preset is missing — pick a replacement."}
        </p>
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
