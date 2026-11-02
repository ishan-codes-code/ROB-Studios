import { useCallback, useEffect, useState } from "react";
import { ArrowUpRight, LoaderCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.jsx";
import { Badge } from "@/components/ui/badge.jsx";
import { Button } from "@/components/ui/button.jsx";
import { Separator } from "@/components/ui/separator.jsx";
import { Spinner } from "@/components/ui/spinner.jsx";
import ApiKeysSection from "@/app/sections/ApiKeysSection.jsx";
import GamesPromptsSection from "@/app/sections/GamesPromptsSection.jsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.jsx";

/**
 * Project-scoped configuration selectors. The editor selects one saved
 * API configuration, one game profile, and one commentary preset; the
 * main process resolves them at run start. Related management screens
 * open in a dialog so project selection stays in context.
 */
export default function ProjectConfiguration({ projectId, onReadinessChange }) {
  const [configuration, setConfiguration] = useState(null);
  const [credential, setCredential] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [credentials, setCredentials] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [presets, setPresets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState("");
  const [error, setError] = useState("");
  const [manager, setManager] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [configRes, credRes, profileRes] = await Promise.all([
        window.api.getProjectConfig(projectId),
        window.api.listCredentials().catch(() => null),
        window.api.listGameProfiles().catch(() => null),
      ]);
      // Populate the selectors from whatever loaded: a configuration
      // failure must not leave every dropdown permanently empty.
      const items = credRes?.ok
        ? (credRes.credentials ?? []).filter((entry) => entry.purpose !== "tts")
        : [];
      setCredentials(items);
      const profileItems = profileRes?.ok ? (profileRes.profiles ?? []) : [];
      setProfiles(profileItems);
      if (!configRes?.ok) throw new Error("Could not load the project configuration.");
      setConfiguration(configRes.configuration);
      setCredential(configRes.credential);
      setWarnings(configRes.warnings ?? []);
      onReadinessChange?.(configRes.credential?.verified === true);
      const presetRes = await window.api
        .listPresets(null)
        .catch(() => null);
      if (presetRes?.ok) {
        const profileId = configRes.configuration?.gameProfileId;
        setPresets(
          (presetRes.presets ?? []).filter(
            (entry) => entry.profileId === profileId || entry.id === "default-energetic",
          ),
        );
      }
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

  const closeManager = useCallback(() => {
    setManager(null);
    // Refresh project selections after adding or editing configuration in
    // the modal, so new entries are immediately selectable.
    load();
  }, [load]);

  const save = useCallback(
    async (field, value) => {
      setSaving(field);
      setError("");
      try {
        const result = await window.api.setProjectConfig(projectId, { [field]: value });
        if (!result?.ok) throw new Error("Could not save the project configuration.");
        setConfiguration(result.configuration);
        const refreshed = await window.api.getProjectConfig(projectId);
        if (refreshed?.ok) {
          setCredential(refreshed.credential);
          setWarnings(refreshed.warnings ?? []);
          onReadinessChange?.(refreshed.credential?.verified === true);
          const presetRes = await window.api.listPresets(null).catch(() => null);
          if (presetRes?.ok) {
            setPresets(
              (presetRes.presets ?? []).filter(
                (entry) => entry.profileId === refreshed.configuration?.gameProfileId || entry.id === "default-energetic",
              ),
            );
          }
        }
      } catch (err) {
        setError(err?.message ?? "Could not save the project configuration.");
      } finally {
        setSaving("");
      }
    },
    [onReadinessChange, projectId],
  );

  if (loading) {
    return (
      <p className="flex items-center gap-2 p-3 text-[12px] text-muted-foreground">
        <Spinner /> Loading project configuration…
      </p>
    );
  }

  const selectedProfile = profiles.find((entry) => entry.id === configuration?.gameProfileId) ?? null;
  const selectedPreset = presets.find((entry) => entry.id === configuration?.commentaryPresetId) ?? null;
  const savedCredentialMissing = (configuration?.credentialId ?? "") !== ""
    && !credentials.some((entry) => entry.id === configuration.credentialId);

  return (
    <div className="flex min-w-0 flex-col gap-4 p-3">
      <section className="flex min-w-0 flex-col gap-2" aria-labelledby="vision-config-title">
        <h2 id="vision-config-title" className="text-[11px] font-medium text-muted-foreground">
          Vision API configuration
        </h2>
        <select
          aria-label="Vision API configuration"
          className="h-8 rounded-sm border border-input bg-background px-2 text-[12px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          value={configuration?.credentialId ?? ""}
          disabled={saving !== ""}
          onChange={(event) => save("credentialId", event.target.value === "" ? null : event.target.value)}
        >
          <option value="">Select a configuration…</option>
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
        {credential ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant={credential.verified ? "secondary" : "outline"}>
              {credential.verified ? "Vision verified" : "Unverified"}
            </Badge>
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
              {credential.provider} · {credential.model}
            </span>
          </div>
        ) : (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {configuration?.credentialId
              ? "The saved configuration is unavailable. Choose another above."
              : credentials.length === 0
                ? "No API configurations exist yet."
                : "No configuration selected for this project."}
          </p>
        )}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="w-full justify-start"
          onClick={() => setManager("api-keys")}
        >
          Add or manage API configurations <ArrowUpRight data-icon="inline-end" />
        </Button>
      </section>

      <Separator />

      <section className="flex min-w-0 flex-col gap-2" aria-labelledby="game-config-title">
        <h2 id="game-config-title" className="text-[11px] font-medium text-muted-foreground">
          Game profile
        </h2>
        <select
          aria-label="Game profile"
          className="h-8 rounded-sm border border-input bg-background px-2 text-[12px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          value={configuration?.gameProfileId ?? "free-fire-default"}
          disabled={saving !== ""}
          onChange={(event) => save("gameProfileId", event.target.value)}
        >
          {profiles.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
              {entry.builtIn ? "" : " · custom"}
            </option>
          ))}
        </select>
        {selectedProfile?.context ? (
          <p className="truncate text-[11px] text-muted-foreground" title={selectedProfile.context}>
            {selectedProfile.context}
          </p>
        ) : null}
      </section>

      <Separator />

      <section className="flex min-w-0 flex-col gap-2" aria-labelledby="preset-config-title">
        <h2 id="preset-config-title" className="text-[11px] font-medium text-muted-foreground">
          Commentary preset
        </h2>
        <select
          aria-label="Commentary preset"
          className="h-8 rounded-sm border border-input bg-background px-2 text-[12px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          value={configuration?.commentaryPresetId ?? "default-energetic"}
          disabled={saving !== ""}
          onChange={(event) => save("commentaryPresetId", event.target.value)}
        >
          {presets.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
              {[entry.tone, entry.language].filter(Boolean).join(" · ")
                ? ` · ${[entry.tone, entry.language].filter(Boolean).join(" · ")}`
                : ""}
            </option>
          ))}
        </select>
        {selectedPreset ? (
          <p className="truncate text-[11px] text-muted-foreground">
            {[selectedPreset.tone, selectedPreset.language].filter(Boolean).join(" · ") || "Default style"}
          </p>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="w-full justify-start"
          onClick={() => setManager("games-prompts")}
        >
          Add or manage games &amp; prompts <ArrowUpRight data-icon="inline-end" />
        </Button>
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
      <Dialog
        open={manager !== null}
        onOpenChange={(open) => {
          if (!open) closeManager();
        }}
      >
        <DialogContent className="max-h-[calc(100vh-2rem)] max-w-5xl overflow-y-auto sm:max-w-5xl">
          <DialogHeader className="sr-only">
            <DialogTitle>
              {manager === "api-keys" ? "Manage API configurations" : "Manage games and prompts"}
            </DialogTitle>
            <DialogDescription>
              Add or update saved configurations for this project.
            </DialogDescription>
          </DialogHeader>
          {manager === "api-keys" ? (
            <ApiKeysSection embedded />
          ) : manager === "games-prompts" ? (
            <GamesPromptsSection embedded />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
