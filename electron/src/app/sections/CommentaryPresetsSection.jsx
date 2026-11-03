import { useState } from "react";
import { ArrowLeft, Check, Copy, LoaderCircle, MessageSquareText, Pencil, Plus, Trash2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.jsx";
import { Button } from "@/components/ui/button.jsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.jsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.jsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.jsx";
import { Skeleton } from "@/components/ui/skeleton.jsx";
import useGameLibrary from "@/hooks/useGameLibrary.js";
import { validateName } from "@/lib/config-validation.js";

const inputClassName =
  "h-9 rounded-md border border-input bg-background px-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

const areaClassName =
  "min-h-24 rounded-md border border-input bg-background px-3 py-2 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

const blankPreset = { name: "", personality: "", tone: "energetic", language: "English", instructions: "" };

function Field({ label, hint, children }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-[13px]">
      <span className="font-medium text-foreground">{label}</span>
      {children}
      {hint ? <span className="text-[12px] text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

/**
 * Commentary Presets library: personality/tone/language records that
 * style generated lines. Edits happen in a sized dialog; the preview
 * shows exactly how the preset words its request plus a labeled style
 * illustration (a static template, never presented as model output).
 * Style guides wording only — evidence rules cannot be overridden.
 */
export default function CommentaryPresetsSection({ onBackToEditor }) {
  const library = useGameLibrary();
  const { profiles, presets, loading, busy, notice, error } = library;
  const [profileFilter, setProfileFilter] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(blankPreset);
  const [draftProfileId, setDraftProfileId] = useState("free-fire-default");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [formError, setFormError] = useState("");

  const visible = profileFilter ? presets.filter((entry) => entry.profileId === profileFilter) : presets;
  const selected = presets.find((entry) => entry.id === selectedId) ?? null;
  const selectedProfileName = profiles.find((entry) => entry.id === selected?.profileId)?.name ?? null;

  const startCreate = () => {
    setSelectedId(null);
    setDraft({ ...blankPreset });
    setDraftProfileId(profileFilter || profiles[0]?.id || "free-fire-default");
    setFormError("");
    setConfirmDelete(false);
    setEditing(true);
  };

  const startEdit = (preset) => {
    setSelectedId(preset.id);
    setDraft({
      // Built-ins cannot be edited: starting from a blank name forces
      // the explicit new-preset path on save.
      name: preset.builtIn ? "" : preset.name,
      personality: preset.personality ?? "",
      tone: preset.tone ?? "",
      language: preset.language ?? "",
      instructions: preset.instructions ?? "",
    });
    setDraftProfileId(preset.profileId);
    setFormError("");
    setConfirmDelete(false);
    setEditing(true);
  };

  const save = async () => {
    const nameError = validateName(draft.name, "Preset name");
    if (nameError) {
      setFormError(nameError);
      return;
    }
    for (const [field, label] of [["personality", "Personality"], ["tone", "Tone"], ["language", "Language"]]) {
      if ((draft[field] ?? "").length > 80) {
        setFormError(`${label} must be 80 characters or fewer.`);
        return;
      }
    }
    if ((draft.instructions ?? "").length > 2000) {
      setFormError("Custom instructions must be 2000 characters or fewer.");
      return;
    }
    const editingCustom = selectedId && !selected?.builtIn;
    const saved = editingCustom
      ? await library.updatePreset(selectedId, {
        name: draft.name.trim(),
        personality: draft.personality,
        tone: draft.tone,
        language: draft.language,
        instructions: draft.instructions,
      })
      : await library.createPreset({
        profileId: draftProfileId,
        name: draft.name.trim(),
        personality: draft.personality,
        tone: draft.tone,
        language: draft.language,
        instructions: draft.instructions,
      });
    if (saved) {
      setSelectedId(saved.id);
      setEditing(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 pb-8">
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[17px] font-semibold tracking-[-0.01em] text-foreground">Commentary Presets</h1>
          <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-muted-foreground">
            Personalities and tones for generated lines. Style preferences guide wording only —
            observation schemas, evidence gates, and factuality checks stay protected.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onBackToEditor ? (
            <Button variant="outline" size="sm" onClick={onBackToEditor}>
              <ArrowLeft data-icon="inline-start" /> Back to editor
            </Button>
          ) : null}
          <Button size="sm" onClick={startCreate} disabled={loading || !!busy}>
            <Plus data-icon="inline-start" /> New preset
          </Button>
        </div>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span id="preset-profile-filter-label" className="text-[12px] text-muted-foreground">
          Profile
        </span>
        <Select
          value={profileFilter === "" ? "__all" : profileFilter}
          disabled={loading || !!busy}
          onValueChange={(next) => setProfileFilter(next === "__all" ? "" : next)}
        >
          <SelectTrigger aria-labelledby="preset-profile-filter-label" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all">All profiles</SelectItem>
            {profiles.map((entry) => (
              <SelectItem key={entry.id} value={entry.id}>{entry.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <div className="flex flex-col gap-2" aria-label="Loading commentary presets">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Presets</CardTitle>
            <CardDescription>
              {visible.length === 0
                ? (profileFilter ? "No presets for this profile yet." : "No presets yet.")
                : `${visible.length} preset${visible.length === 1 ? "" : "s"}. The built-in preset is always available.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <ul className="flex flex-col gap-1.5">
              {visible.map((preset) => (
                <li
                  key={preset.id}
                  className={`flex min-w-0 items-center gap-2.5 rounded-sm border px-2.5 py-2 ${
                    selectedId === preset.id ? "border-ring bg-accent" : "border-border bg-background"
                  }`}
                >
                  <MessageSquareText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedId(preset.id);
                      setConfirmDelete(false);
                    }}
                    className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="block truncate text-[13px] font-medium text-foreground">
                      {preset.name}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                      {[preset.tone, preset.language].filter(Boolean).join(" · ")}
                      {preset.builtIn ? " · Built-in" : ""}
                    </span>
                  </button>
                  <span className="flex shrink-0 gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!!busy}
                      aria-label={`Edit ${preset.name}`}
                      onClick={() => startEdit(preset)}
                    >
                      <Pencil data-icon="inline-start" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!!busy}
                      aria-label={`Duplicate ${preset.name}`}
                      onClick={async () => {
                        const copy = await library.duplicatePreset(preset.id, null);
                        if (copy) setSelectedId(copy.id);
                      }}
                    >
                      <Copy data-icon="inline-start" />
                    </Button>
                    {!preset.builtIn ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!!busy}
                        aria-label={`Delete ${preset.name}`}
                        onClick={() => {
                          setSelectedId(preset.id);
                          setConfirmDelete(true);
                        }}
                      >
                        <Trash2 data-icon="inline-start" />
                      </Button>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {selected ? (
        <Card>
          <CardHeader>
            <CardTitle>{selected.name}</CardTitle>
            <CardDescription>
              {selectedProfileName ? `For ${selectedProfileName}. ` : ""}
              {selected.builtIn ? "Built-in preset. It always exists and cannot be edited or deleted." : "Custom preset."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <dl className="flex flex-col gap-1.5 text-[12px]">
              {[
                ["Personality", selected.personality || "—"],
                ["Tone", selected.tone || "—"],
                ["Language", selected.language || "—"],
              ].map(([term, value]) => (
                <div key={term} className="flex min-w-0 items-baseline justify-between gap-3">
                  <dt className="shrink-0 text-muted-foreground">{term}</dt>
                  <dd className="min-w-0 truncate text-right text-foreground" title={value}>{value}</dd>
                </div>
              ))}
            </dl>
            <div className="rounded-sm border border-border bg-muted p-3 text-[12px] leading-relaxed text-muted-foreground">
              <strong className="text-foreground">Commentary preview</strong>
              <p className="mt-1">
                You are a concise Free Fire commentator. Use {selected.tone || "the preset"} language in{" "}
                {selected.language || "the selected language"} as a {selected.personality || "commentator"}.
                Custom style: {selected.instructions || "none"}. Only gated evidence may be stated;
                uncertainty stays explicit.
              </p>
              <p className="mt-2 border-t border-border pt-2">
                Style illustration (template, not generated): a {selected.tone || "lively"} call in{" "}
                {selected.language || "English"} — “He takes the high ground and the round swings!”
              </p>
            </div>
            {!selected.builtIn && !confirmDelete ? (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={!!busy} onClick={() => startEdit(selected)}>
                  <Pencil data-icon="inline-start" /> Edit preset
                </Button>
                <Button size="sm" variant="outline" disabled={!!busy} onClick={() => setConfirmDelete(true)}>
                  <Trash2 data-icon="inline-start" /> Delete preset
                </Button>
              </div>
            ) : null}
            {!selected.builtIn && confirmDelete ? (
              <div className="flex flex-wrap items-center gap-2 rounded-sm border border-border bg-background px-3 py-2.5">
                <p className="mr-auto text-[12px] text-muted-foreground">
                  Delete “{selected.name}”? Projects using it must choose another preset first.
                </p>
                <Button size="sm" variant="outline" disabled={!!busy} onClick={() => setConfirmDelete(false)}>
                  Keep
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={!!busy}
                  onClick={async () => {
                    const ok = await library.deletePreset(selected.id);
                    if (ok) {
                      setSelectedId(null);
                      setConfirmDelete(false);
                    }
                  }}
                >
                  <Trash2 data-icon="inline-start" /> Delete
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Dialog open={editing} onOpenChange={(open) => {
        if (!open && !busy) setEditing(false);
      }}>
        <DialogContent className="max-h-[calc(100vh-2rem)] overflow-y-auto sm:max-w-[32rem]">
          <DialogHeader>
            <DialogTitle>
              {selectedId && !selected?.builtIn ? `Edit ${selected?.name ?? "preset"}` : "New commentary preset"}
            </DialogTitle>
            <DialogDescription>
              {selected?.builtIn
                ? "The built-in preset cannot be edited. Saving creates a new custom preset from these values."
                : "Style preferences only. Evidence and uncertainty rules cannot be overridden."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <Field label="Preset name">
              <input
                className={inputClassName}
                value={draft.name}
                maxLength={80}
                placeholder={selected?.builtIn ? "Name the new preset…" : "e.g. Finals — Hype"}
                disabled={!!busy}
                onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
              />
            </Field>
            {!(selectedId && !selected?.builtIn) ? (
              <Field label="Game profile" hint="Presets belong to one profile and cannot move later.">
                <Select value={draftProfileId} onValueChange={setDraftProfileId} disabled={!!busy}>
                  <SelectTrigger aria-label="Game profile" className="w-full text-[13px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {profiles.map((entry) => (
                      <SelectItem key={entry.id} value={entry.id}>{entry.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : null}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Personality">
                <input
                  className={inputClassName}
                  value={draft.personality}
                  maxLength={80}
                  disabled={!!busy}
                  onChange={(event) => setDraft((current) => ({ ...current, personality: event.target.value }))}
                />
              </Field>
              <Field label="Tone">
                <input
                  className={inputClassName}
                  value={draft.tone}
                  maxLength={80}
                  disabled={!!busy}
                  onChange={(event) => setDraft((current) => ({ ...current, tone: event.target.value }))}
                />
              </Field>
              <Field label="Language">
                <input
                  className={inputClassName}
                  value={draft.language}
                  maxLength={80}
                  disabled={!!busy}
                  onChange={(event) => setDraft((current) => ({ ...current, language: event.target.value }))}
                />
              </Field>
            </div>
            <Field
              label="Custom style instructions"
              hint="Style preferences only. Evidence and uncertainty rules cannot be overridden."
            >
              <textarea
                className={areaClassName}
                value={draft.instructions}
                maxLength={2000}
                disabled={!!busy}
                placeholder="Style preferences only."
                onChange={(event) => setDraft((current) => ({ ...current, instructions: event.target.value }))}
              />
            </Field>
            {formError ? (
              <Alert variant="destructive">
                <AlertTitle>Check the form</AlertTitle>
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            ) : null}
          </div>
          <DialogFooter>
            <Button size="sm" variant="outline" disabled={!!busy} onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={!!busy || !draft.name.trim()} onClick={save}>
              {busy === "preset-save" ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
              {selectedId && !selected?.builtIn ? "Save preset" : "Create preset"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
