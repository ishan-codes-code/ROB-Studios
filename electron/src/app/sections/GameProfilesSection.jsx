import { useState } from "react";
import { ArrowLeft, Check, Copy, Gamepad2, LoaderCircle, Pencil, Plus, Trash2 } from "lucide-react";
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
import { Skeleton } from "@/components/ui/skeleton.jsx";
import { Spinner } from "@/components/ui/spinner.jsx";
import useGameLibrary from "@/hooks/useGameLibrary.js";
import { validateName } from "@/lib/config-validation.js";

const inputClassName =
  "h-9 rounded-md border border-input bg-background px-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

const areaClassName =
  "min-h-24 rounded-md border border-input bg-background px-3 py-2 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

/**
 * Game Profiles library: match-context records (currently Free Fire)
 * that projects reference. Built-in default is immutable; custom
 * profiles support create, edit, duplicate, and guarded delete
 * (blocked while presets or projects reference them).
 */
export default function GameProfilesSection({ onBackToEditor }) {
  const library = useGameLibrary();
  const { profiles, loading, busy, notice, error } = library;
  const [selectedId, setSelectedId] = useState(null);
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ name: "", context: "" });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [formError, setFormError] = useState("");

  const selected = profiles.find((entry) => entry.id === selectedId) ?? null;

  const startCreate = () => {
    setCreating(true);
    setEditing(false);
    setSelectedId(null);
    setDraft({ name: "", context: "" });
    setFormError("");
    setConfirmDelete(false);
  };

  const startEdit = (profile) => {
    setSelectedId(profile.id);
    setCreating(false);
    setEditing(true);
    setDraft({ name: profile.name, context: profile.context ?? "" });
    setFormError("");
    setConfirmDelete(false);
  };

  const cancel = () => {
    setCreating(false);
    setEditing(false);
    setDraft({ name: "", context: "" });
    setFormError("");
    setConfirmDelete(false);
  };

  const save = async () => {
    const nameError = validateName(draft.name, "Profile name");
    if (nameError) {
      setFormError(nameError);
      return;
    }
    if (draft.context.length > 2000) {
      setFormError("Gameplay context must be 2000 characters or fewer.");
      return;
    }
    const saved = creating
      ? await library.createProfile({ name: draft.name, context: draft.context })
      : await library.updateProfile(selected.id, { name: draft.name.trim(), context: draft.context });
    if (saved) {
      setSelectedId(saved.id);
      setCreating(false);
      setEditing(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 pb-8">
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[17px] font-semibold tracking-[-0.01em] text-foreground">Game Profiles</h1>
          <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-muted-foreground">
            Match-context records projects commentate on. Gameplay context guides wording only —
            the model must still rely on visible evidence.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onBackToEditor ? (
            <Button variant="outline" size="sm" onClick={onBackToEditor}>
              <ArrowLeft data-icon="inline-start" /> Back to editor
            </Button>
          ) : null}
          <Button size="sm" onClick={startCreate} disabled={loading || !!busy || creating}>
            <Plus data-icon="inline-start" /> New profile
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex flex-col gap-2" aria-label="Loading game profiles">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Profiles</CardTitle>
            <CardDescription>
              {profiles.length === 0
                ? "No profiles."
                : `${profiles.length} profile${profiles.length === 1 ? "" : "s"}. Free Fire only for this milestone.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <ul className="flex flex-col gap-1.5">
              {profiles.map((profile) => (
                <li
                  key={profile.id}
                  className={`flex min-w-0 items-center gap-2.5 rounded-sm border px-2.5 py-2 ${
                    selectedId === profile.id ? "border-ring bg-accent" : "border-border bg-background"
                  }`}
                >
                  <Gamepad2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedId(profile.id);
                      setCreating(false);
                      setEditing(false);
                      setConfirmDelete(false);
                    }}
                    className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="block truncate text-[13px] font-medium text-foreground">
                      {profile.name}
                    </span>
                    <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                      {profile.builtIn ? "Built-in default" : profile.context || "Custom profile"}
                    </span>
                  </button>
                  {profile.builtIn ? <Badge variant="outline">Default</Badge> : null}
                  <span className="flex shrink-0 gap-1">
                    {!profile.builtIn ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!!busy}
                        aria-label={`Edit ${profile.name}`}
                        onClick={() => startEdit(profile)}
                      >
                        <Pencil data-icon="inline-start" />
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!!busy}
                      aria-label={`Duplicate ${profile.name}`}
                      onClick={async () => {
                        const copy = await library.duplicateProfile(profile);
                        if (copy) setSelectedId(copy.id);
                      }}
                    >
                      <Copy data-icon="inline-start" />
                    </Button>
                    {!profile.builtIn ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!!busy}
                        aria-label={`Delete ${profile.name}`}
                        onClick={() => {
                          setSelectedId(profile.id);
                          setCreating(false);
                          setEditing(false);
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

      {creating || (editing && selected && !selected.builtIn) ? (
        <Card>
          <CardHeader>
            <CardTitle>{creating ? "New game profile" : `Edit ${selected?.name}`}</CardTitle>
            <CardDescription>
              {creating ? "Free Fire profiles only for this milestone." : "Changes apply to projects using this profile."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <label className="flex min-w-0 flex-col gap-1.5 text-[13px]">
              <span className="font-medium text-foreground">Profile name</span>
              <input
                className={inputClassName}
                value={draft.name}
                maxLength={80}
                placeholder="Free Fire — Ranked"
                disabled={!!busy}
                onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1.5 text-[13px]">
              <span className="font-medium text-foreground">Gameplay context</span>
              <textarea
                className={areaClassName}
                value={draft.context}
                maxLength={2000}
                placeholder="Optional background: maps, pacing, terminology."
                disabled={!!busy}
                onChange={(event) => setDraft((current) => ({ ...current, context: event.target.value }))}
              />
              <span className="text-[12px] text-muted-foreground">Optional background. The model must still rely on visible evidence.</span>
            </label>
            {formError ? (
              <Alert variant="destructive">
                <AlertTitle>Check the form</AlertTitle>
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={!!busy || !draft.name.trim()} onClick={save}>
                {busy ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
                {creating ? "Create profile" : "Save profile"}
              </Button>
              <Button size="sm" variant="outline" disabled={!!busy} onClick={cancel}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {selected && !creating && !editing ? (
        <Card>
          <CardHeader>
            <CardTitle>{selected.name}</CardTitle>
            <CardDescription>
              {selected.builtIn
                ? "Built-in default profile. It always exists and cannot be edited or deleted."
                : "Custom Free Fire profile."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {selected.context || "No additional gameplay context."}
            </p>
            {!selected.builtIn && !confirmDelete ? (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={!!busy} onClick={() => startEdit(selected)}>
                  <Pencil data-icon="inline-start" /> Edit profile
                </Button>
                <Button size="sm" variant="outline" disabled={!!busy} onClick={() => setConfirmDelete(true)}>
                  <Trash2 data-icon="inline-start" /> Delete profile
                </Button>
              </div>
            ) : null}
            {!selected.builtIn && confirmDelete ? (
              <div className="flex flex-wrap items-center gap-2 rounded-sm border border-border bg-background px-3 py-2.5">
                <p className="mr-auto text-[12px] text-muted-foreground">
                  Delete “{selected.name}”? Projects and presets using it must change first.
                </p>
                <Button size="sm" variant="outline" disabled={!!busy} onClick={() => setConfirmDelete(false)}>
                  Keep
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={!!busy}
                  onClick={async () => {
                    const ok = await library.deleteProfile(selected.id);
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
    </div>
  );
}
