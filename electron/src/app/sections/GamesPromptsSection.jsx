import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  Check,
  Copy,
  Gamepad2,
  LoaderCircle,
  MessageSquareText,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.jsx";
import { Badge } from "@/components/ui/badge.jsx";
import { Button } from "@/components/ui/button.jsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.jsx";
import { Separator } from "@/components/ui/separator.jsx";
import { Spinner } from "@/components/ui/spinner.jsx";

const inputClassName =
  "h-9 rounded-md border border-input bg-background px-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

const areaClassName =
  "min-h-24 rounded-md border border-input bg-background px-3 py-2 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

function Field({ label, hint, children }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-[13px]">
      <span className="font-medium text-foreground">{label}</span>
      {children}
      {hint ? <span className="text-[12px] text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

const blankPreset = { name: "", personality: "", tone: "energetic", language: "English", instructions: "" };

export default function GamesPromptsSection({ onBackToEditor }) {
  const [profiles, setProfiles] = useState([]);
  const [presets, setPresets] = useState([]);
  const [selectedProfileId, setSelectedProfileId] = useState("free-fire-default");
  const [selectedPresetId, setSelectedPresetId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [profileDraft, setProfileDraft] = useState({ name: "", context: "" });
  const [addingProfile, setAddingProfile] = useState(false);
  const [presetDraft, setPresetDraft] = useState(blankPreset);
  const [editingPreset, setEditingPreset] = useState(false);

  const reload = useCallback(async (profileId) => {
    setLoading(true);
    setError("");
    try {
      const [profileRes, presetRes] = await Promise.all([
        window.api.listGameProfiles(),
        window.api.listPresets(profileId ?? null),
      ]);
      if (!profileRes?.ok) throw new Error("Could not load game profiles.");
      if (!presetRes?.ok) throw new Error("Could not load commentary presets.");
      setProfiles(profileRes.profiles ?? []);
      setPresets(presetRes.presets ?? []);
    } catch (err) {
      setError(err?.message ?? "Could not load game configuration.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload("free-fire-default");
  }, [reload]);

  const selectProfile = useCallback(
    async (id) => {
      setSelectedProfileId(id);
      setSelectedPresetId(null);
      setEditingPreset(false);
      setPresetDraft(blankPreset);
      const found = profiles.find((entry) => entry.id === id);
      setProfileDraft({ name: found?.builtIn ? found.name : found?.name ?? "", context: found?.context ?? "" });
      try {
        const presetRes = await window.api.listPresets(id);
        if (presetRes?.ok) setPresets(presetRes.presets ?? []);
      } catch {
        // Preset list refresh is best-effort here.
      }
    },
    [profiles],
  );

  const selectedProfile = profiles.find((entry) => entry.id === selectedProfileId) ?? null;
  const selectedPreset = presets.find((entry) => entry.id === selectedPresetId) ?? null;

  const createProfile = useCallback(async () => {
    setBusy("profile-create");
    setError("");
    setNotice("");
    try {
      const result = await window.api.createGameProfile({ name: profileDraft.name.trim(), context: profileDraft.context });
      if (!result?.ok) throw new Error("Could not create the game profile.");
      setNotice(`Created profile “${result.profile.name}”.`);
      setAddingProfile(false);
      setProfileDraft({ name: result.profile.name, context: result.profile.context ?? "" });
      await reload("free-fire-default");
      const full = await window.api.listGameProfiles();
      if (full?.ok) {
        setProfiles(full.profiles ?? []);
        setSelectedProfileId(result.profile.id);
      }
    } catch (err) {
      setError(err?.message ?? "Could not create the game profile.");
    } finally {
      setBusy("");
    }
  }, [profileDraft, reload, selectProfile]);

  const saveProfile = useCallback(async () => {
    if (!selectedProfile || selectedProfile.builtIn) return;
    setBusy("profile-save");
    setError("");
    setNotice("");
    try {
      const result = await window.api.updateGameProfile(selectedProfile.id, {
        name: profileDraft.name.trim(),
        context: profileDraft.context,
      });
      if (!result?.ok) throw new Error("Could not save the game profile.");
      setNotice("Game profile saved.");
      const full = await window.api.listGameProfiles();
      if (full?.ok) setProfiles(full.profiles ?? []);
    } catch (err) {
      setError(err?.message ?? "Could not save the game profile.");
    } finally {
      setBusy("");
    }
  }, [profileDraft, selectedProfile]);

  const deleteProfile = useCallback(async () => {
    if (!selectedProfile || selectedProfile.builtIn) return;
    setBusy("profile-delete");
    setError("");
    try {
      const result = await window.api.deleteGameProfile(selectedProfile.id);
      if (!result?.ok) {
        if (Array.isArray(result?.referencedBy) && result.referencedBy.length > 0) {
          throw new Error(`In use by ${result.referencedBy.length} project(s). Change those projects first.`);
        }
        throw new Error("Could not delete the game profile.");
      }
      setNotice("Game profile deleted.");
      setSelectedProfileId("free-fire-default");
      setProfileDraft({ name: "Free Fire — Default", context: "" });
      await reload("free-fire-default");
      const full = await window.api.listGameProfiles();
      if (full?.ok) setProfiles(full.profiles ?? []);
    } catch (err) {
      setError(err?.message ?? "Could not delete the game profile.");
    } finally {
      setBusy("");
    }
  }, [reload, selectedProfile]);

  const startPresetEditor = useCallback((preset) => {
    if (preset) {
      setSelectedPresetId(preset.id);
      setPresetDraft({
        // Built-ins cannot be edited or name-collided: starting from a
        // blank name forces the explicit new-preset path below.
        name: preset.builtIn ? "" : preset.name,
        personality: preset.personality,
        tone: preset.tone,
        language: preset.language,
        instructions: preset.instructions,
      });
    } else {
      setSelectedPresetId(null);
      setPresetDraft(blankPreset);
    }
    setEditingPreset(true);
    setError("");
    setNotice("");
  }, []);

  const savePreset = useCallback(async () => {
    setBusy("preset-save");
    setError("");
    setNotice("");
    try {
      let result;
      if (selectedPresetId && !selectedPreset?.builtIn) {
        result = await window.api.updatePreset(selectedPresetId, { ...presetDraft, name: presetDraft.name.trim() });
        if (!result?.ok) throw new Error("Could not save the preset.");
        setNotice("Preset saved.");
      } else {
        result = await window.api.createPreset({ profileId: selectedProfileId, ...presetDraft, name: presetDraft.name.trim() });
        if (!result?.ok) throw new Error("Could not create the preset.");
        setNotice(`Created preset “${result.preset.name}”.`);
        setSelectedPresetId(result.preset.id);
      }
      setEditingPreset(false);
      const presetRes = await window.api.listPresets(selectedProfileId);
      if (presetRes?.ok) setPresets(presetRes.presets ?? []);
    } catch (err) {
      setError(err?.message ?? "Could not save the preset.");
    } finally {
      setBusy("");
    }
  }, [presetDraft, selectedPreset, selectedPresetId, selectedProfileId]);

  const duplicatePreset = useCallback(
    async (id) => {
      setBusy("preset-duplicate");
      setError("");
      try {
        const result = await window.api.duplicatePreset(id, null);
        if (!result?.ok) throw new Error("Could not duplicate the preset.");
        setNotice(`Duplicated as “${result.preset.name}”.`);
        const presetRes = await window.api.listPresets(selectedProfileId);
        if (presetRes?.ok) setPresets(presetRes.presets ?? []);
      } catch (err) {
        setError(err?.message ?? "Could not duplicate the preset.");
      } finally {
        setBusy("");
      }
    },
    [selectedProfileId],
  );

  const deletePreset = useCallback(
    async (id) => {
      setBusy("preset-delete");
      setError("");
      try {
        const result = await window.api.deletePreset(id);
        if (!result?.ok) {
          if (Array.isArray(result?.referencedBy) && result.referencedBy.length > 0) {
            throw new Error(`In use by ${result.referencedBy.length} project(s). Change those projects first.`);
          }
          throw new Error("Could not delete the preset.");
        }
        setNotice("Preset deleted.");
        if (id === selectedPresetId) {
          setSelectedPresetId(null);
          setEditingPreset(false);
        }
        const presetRes = await window.api.listPresets(selectedProfileId);
        if (presetRes?.ok) setPresets(presetRes.presets ?? []);
      } catch (err) {
        setError(err?.message ?? "Could not delete the preset.");
      } finally {
        setBusy("");
      }
    },
    [selectedPresetId, selectedProfileId],
  );

  useEffect(() => {
    if (selectedProfile) {
      setProfileDraft({ name: selectedProfile.name, context: selectedProfile.context ?? "" });
    }
  }, [selectedProfileId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 pb-8">
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[17px] font-semibold tracking-[-0.01em] text-foreground">Games &amp; Prompts</h1>
          <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-muted-foreground">
            Free Fire profiles and commentary presets. Style preferences guide wording only —
            observation schemas, evidence gates, and factuality checks stay protected.
          </p>
        </div>
        {onBackToEditor ? (
          <Button variant="outline" size="sm" onClick={onBackToEditor}>
            <ArrowLeft data-icon="inline-start" /> Back to editor
          </Button>
        ) : null}
      </div>

      {loading ? (
        <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Spinner /> Loading game configuration…
        </p>
      ) : (
        <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
          <Card className="min-w-0 self-start">
            <CardHeader>
              <CardTitle>Game profiles</CardTitle>
              <CardDescription>Free Fire only for this milestone.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <ul className="flex flex-col gap-1.5">
                {profiles.map((profile) => (
                  <li key={profile.id}>
                    <button
                      type="button"
                      onClick={() => selectProfile(profile.id)}
                      aria-current={selectedProfileId === profile.id ? "true" : undefined}
                      className={`flex w-full min-w-0 items-center gap-2.5 rounded-sm border px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                        selectedProfileId === profile.id
                          ? "border-ring bg-accent"
                          : "border-border bg-background hover:bg-accent"
                      }`}
                    >
                      <Gamepad2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-foreground">
                          {profile.name}
                        </span>
                        <span className="mt-0.5 block text-[11px] text-muted-foreground">
                          {profile.builtIn ? "Built-in default" : "Custom profile"}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {!addingProfile ? (
                <Button size="sm" variant="outline" onClick={() => { setAddingProfile(true); setProfileDraft({ name: "", context: "" }); }}>
                  <Plus data-icon="inline-start" /> New profile
                </Button>
              ) : (
                <div className="flex flex-col gap-2 rounded-sm border border-border bg-background p-2.5">
                  <input
                    className={inputClassName}
                    value={profileDraft.name}
                    maxLength={80}
                    placeholder="Free Fire — Ranked"
                    onChange={(event) => setProfileDraft((current) => ({ ...current, name: event.target.value }))}
                  />
                  <div className="flex gap-2">
                    <Button size="sm" disabled={!!busy || !profileDraft.name.trim()} onClick={createProfile}>
                      Create
                    </Button>
                    <Button size="sm" variant="outline" disabled={!!busy} onClick={() => setAddingProfile(false)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <div className="flex min-w-0 flex-col gap-4">
            {selectedProfile ? (
              <Card>
                <CardHeader>
                  <CardTitle>{selectedProfile.name}</CardTitle>
                  <CardDescription>
                    {selectedProfile.builtIn
                      ? "Built-in default profile. It always exists and cannot be edited or deleted."
                      : "Custom Free Fire profile."}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <Field label="Profile name">
                    <input
                      className={inputClassName}
                      value={profileDraft.name}
                      maxLength={80}
                      disabled={!!busy || selectedProfile.builtIn}
                      onChange={(event) => setProfileDraft((current) => ({ ...current, name: event.target.value }))}
                    />
                  </Field>
                  <Field
                    label="Additional game context"
                    hint="Optional background. The model must still rely on visible evidence."
                  >
                    <textarea
                      className={areaClassName}
                      value={profileDraft.context}
                      maxLength={2000}
                      disabled={!!busy || selectedProfile.builtIn}
                      placeholder="Optional background context."
                      onChange={(event) => setProfileDraft((current) => ({ ...current, context: event.target.value }))}
                    />
                  </Field>
                  {!selectedProfile.builtIn ? (
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" disabled={!!busy} onClick={saveProfile}>
                        Save profile
                      </Button>
                      <Button size="sm" variant="outline" disabled={!!busy} onClick={deleteProfile}>
                        <Trash2 data-icon="inline-start" /> Delete profile
                      </Button>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            ) : null}

            <Card>
              <CardHeader>
                <CardTitle>Commentary presets</CardTitle>
                <CardDescription>
                  Styles for {selectedProfile?.name ?? "the selected profile"}. The built-in preset is
                  always available.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                <ul className="flex flex-col gap-1.5">
                  {presets.map((preset) => (
                    <li
                      key={preset.id}
                      className={`flex min-w-0 items-center gap-2.5 rounded-sm border px-2.5 py-2 ${
                        selectedPresetId === preset.id && editingPreset
                          ? "border-ring bg-accent"
                          : "border-border bg-background"
                      }`}
                    >
                      <MessageSquareText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-foreground">
                          {preset.name}
                        </span>
                        <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                          {[preset.tone, preset.language].filter(Boolean).join(" · ")}
                          {preset.builtIn ? " · Built-in" : ""}
                        </span>
                      </span>
                      <span className="flex shrink-0 gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!!busy}
                          aria-label={`Edit ${preset.name}`}
                          onClick={() => startPresetEditor(preset)}
                        >
                          <Pencil data-icon="inline-start" />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={!!busy}
                          aria-label={`Duplicate ${preset.name}`}
                          onClick={() => duplicatePreset(preset.id)}
                        >
                          <Copy data-icon="inline-start" />
                        </Button>
                        {!preset.builtIn ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={!!busy}
                            aria-label={`Delete ${preset.name}`}
                            onClick={() => deletePreset(preset.id)}
                          >
                            <Trash2 data-icon="inline-start" />
                          </Button>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
                {!editingPreset ? (
                  <Button size="sm" variant="outline" className="self-start" onClick={() => startPresetEditor(null)}>
                    <Plus data-icon="inline-start" /> New preset
                  </Button>
                ) : (
                  <div className="flex flex-col gap-3 rounded-sm border border-border bg-background p-3">
                    <Field label="Preset name">
                      <input
                        className={inputClassName}
                        value={presetDraft.name}
                        maxLength={80}
                        placeholder={selectedPreset?.builtIn ? "Name the new preset…" : ""}
                        disabled={!!busy}
                        onChange={(event) => setPresetDraft((current) => ({ ...current, name: event.target.value }))}
                      />
                    </Field>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                      <Field label="Personality">
                        <input
                          className={inputClassName}
                          value={presetDraft.personality}
                          maxLength={80}
                          disabled={!!busy}
                          onChange={(event) => setPresetDraft((current) => ({ ...current, personality: event.target.value }))}
                        />
                      </Field>
                      <Field label="Tone">
                        <input
                          className={inputClassName}
                          value={presetDraft.tone}
                          maxLength={80}
                          disabled={!!busy}
                          onChange={(event) => setPresetDraft((current) => ({ ...current, tone: event.target.value }))}
                        />
                      </Field>
                      <Field label="Language">
                        <input
                          className={inputClassName}
                          value={presetDraft.language}
                          maxLength={80}
                          disabled={!!busy}
                          onChange={(event) => setPresetDraft((current) => ({ ...current, language: event.target.value }))}
                        />
                      </Field>
                    </div>
                    <Field
                      label="Custom style instructions"
                      hint="Style preferences only. Evidence and uncertainty rules cannot be overridden."
                    >
                      <textarea
                        className={areaClassName}
                        value={presetDraft.instructions}
                        maxLength={2000}
                        disabled={!!busy}
                        placeholder="Style preferences only."
                        onChange={(event) => setPresetDraft((current) => ({ ...current, instructions: event.target.value }))}
                      />
                    </Field>
                    {selectedPreset?.builtIn ? (
                      <p className="text-[12px] leading-relaxed text-muted-foreground">
                        The built-in preset cannot be edited. Saving creates a new custom preset
                        from these values under the name above.
                      </p>
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={!!busy || !presetDraft.name.trim()}
                        onClick={savePreset}
                      >
                        {selectedPresetId && !selectedPreset?.builtIn ? "Save preset" : "Create preset"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!!busy}
                        onClick={() => { setEditingPreset(false); setSelectedPresetId(null); setPresetDraft(blankPreset); }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
                {selectedPreset && !selectedPreset.builtIn ? (
                  <div className="rounded-sm border border-border bg-muted p-3 text-[12px] leading-relaxed text-muted-foreground">
                    <strong className="text-foreground">Prompt preview</strong>
                    <p className="mt-1">
                      You are a concise Free Fire commentator. Use {selectedPreset.tone || "the preset"} language in{" "}
                      {selectedPreset.language || "the selected language"} as a {selectedPreset.personality || "commentator"}.
                      Custom style: {selectedPreset.instructions || "none"}. Only gated evidence may be stated;
                      uncertainty stays explicit.
                    </p>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          </div>
        </div>
      )}

      {busy ? (
        <p role="status" className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" /> Working…
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="flex items-start gap-2 text-[13px] text-muted-foreground">
          <Check className="mt-0.5 size-4 shrink-0" /> {notice}
        </p>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <p className="text-[12px] leading-relaxed text-muted-foreground">
        Protected system instructions — observation schema, evidence requirements, claim gating,
        timestamp validation, and script checks — are never editable here.
      </p>
    </div>
  );
}
