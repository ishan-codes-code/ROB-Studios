import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Gamepad2, LoaderCircle, RotateCcw } from "lucide-react";
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

const areaClassName =
  "min-h-24 rounded-md border border-input bg-background px-3 py-2 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

const FIELD_GROUPS = [
  { id: "vision", title: "Vision prompts", fields: ["vision_intro", "vision_coverage", "vision_coverage_adaptive", "vision_sampling", "vision_closing", "vision_closing_adaptive", "game_context", "game_label"] },
  { id: "script", title: "Script prompt", fields: ["script_persona", "script_priorities", "script_rules", "script_closing"] },
  { id: "writer", title: "Commentary writer prompt", fields: ["writer_persona", "writer_rules"] },
];

function FieldEditor({ fieldKey, meta, factoryText, effectiveText, customized, busy, onSave }) {
  const [draft, setDraft] = useState(effectiveText);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(effectiveText);
  }, [effectiveText, editing]);

  const dirty = draft.trim() !== effectiveText.trim();
  const overLimit = draft.trim().length > meta.maxChars;

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-md border border-border bg-background p-3">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <p className="text-[13px] font-medium text-foreground">{meta.label}</p>
        <Badge variant={customized ? "default" : "outline"}>
          {customized ? "Customized" : "Factory default"}
        </Badge>
      </div>
      {meta.description ? (
        <p className="text-[12px] text-muted-foreground">{meta.description}</p>
      ) : null}
      {!editing ? (
        <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-muted-foreground">
          {effectiveText === "" ? "(empty)" : effectiveText}
        </p>
      ) : (
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className="sr-only">{meta.label}</span>
          <textarea
            className={areaClassName}
            value={draft}
            rows={6}
            maxLength={meta.maxChars + 100}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
          />
          <span className="text-[12px] text-muted-foreground">
            {draft.trim().length} / {meta.maxChars} characters
            {overLimit ? " — too long to save" : ""}
          </span>
        </label>
      )}
      {customized && !editing ? (
        <details className="text-[12px] text-muted-foreground">
          <summary className="cursor-pointer text-[12px] font-medium text-foreground">
            Show factory default
          </summary>
          <p className="mt-1 whitespace-pre-wrap leading-relaxed">
            {factoryText === "" ? "(empty)" : factoryText}
          </p>
        </details>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {!editing ? (
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { setDraft(effectiveText); setEditing(true); }}>
            Edit
          </Button>
        ) : (
          <>
            <Button
              type="button"
              size="sm"
              disabled={busy || !dirty || overLimit}
              onClick={() => onSave(fieldKey, draft)}
            >
              {busy ? <LoaderCircle className="animate-spin" data-icon="inline-start" /> : null}
              Save
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => { setDraft(effectiveText); setEditing(false); }}>
              Cancel
            </Button>
          </>
        )}
        {customized ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => onSave(fieldKey, "")}
            title="Restore the factory default for this prompt"
          >
            <RotateCcw data-icon="inline-start" />
            Restore default
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export default function PromptPacksSection({ onBackToEditor }) {
  const [packs, setPacks] = useState([]);
  const [fieldMeta, setFieldMeta] = useState({});
  const [defaultPackId, setDefaultPackId] = useState("free-fire");
  const [selectedPackId, setSelectedPackId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const selectedPackIdRef = useRef(null);
  selectedPackIdRef.current = selectedPackId;

  const reload = useCallback(async (selectId) => {
    setLoading(true);
    setError("");
    try {
      if (typeof window.api?.listPromptPacks !== "function") {
        throw new Error("Prompt packs are unavailable in this build.");
      }
      const result = await window.api.listPromptPacks();
      if (!result?.ok) throw new Error("Could not load prompt packs.");
      setPacks(result.packs ?? []);
      setFieldMeta(result.fieldMeta ?? {});
      setDefaultPackId(result.defaultPackId ?? "free-fire");
      const available = result.packs ?? [];
      if (available.length > 0) {
        const wanted = selectId ?? selectedPackIdRef.current ?? result.defaultPackId;
        setSelectedPackId(available.some((pack) => pack.packId === wanted) ? wanted : available[0].packId);
      }
    } catch (err) {
      setError(err?.message ?? "Could not load prompt packs.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload(null);
  }, [reload]);

  const selectedPack = packs.find((pack) => pack.packId === selectedPackId) ?? null;

  const saveField = useCallback(async (field, text) => {
    if (!selectedPack) return;
    setBusy(`field-${field}`);
    setError("");
    setNotice("");
    try {
      const result = await window.api.setPromptField(selectedPack.packId, field, text);
      if (!result?.ok) throw new Error("Could not save the prompt.");
      setNotice(text.trim() === "" ? "Factory default restored." : "Prompt saved.");
      setPacks((current) => current.map((pack) => (pack.packId === result.pack.packId ? result.pack : pack)));
    } catch (err) {
      setError(err?.message ?? "Could not save the prompt.");
    } finally {
      setBusy("");
    }
  }, [selectedPack]);

  const resetPack = useCallback(async () => {
    if (!selectedPack) return;
    setBusy("pack-reset");
    setError("");
    setNotice("");
    try {
      const result = await window.api.resetPromptPack(selectedPack.packId);
      if (!result?.ok) throw new Error("Could not reset the prompt pack.");
      setNotice(`“${selectedPack.displayName}” restored to factory defaults.`);
      setPacks((current) => current.map((pack) => (pack.packId === result.pack.packId ? result.pack : pack)));
    } catch (err) {
      setError(err?.message ?? "Could not reset the prompt pack.");
    } finally {
      setBusy("");
    }
  }, [selectedPack]);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 pb-8">
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[17px] font-semibold tracking-[-0.01em] text-foreground">Prompt Packs</h1>
          <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-muted-foreground">
            Game-specific wording for every prompt the application sends. Factory defaults ship
            with the app and are never overwritten — your edits are stored separately and can
            be restored at any time. JSON response shapes and evidence validators stay protected.
          </p>
        </div>
        {onBackToEditor ? (
          <Button variant="outline" size="sm" onClick={onBackToEditor}>
            <ArrowLeft data-icon="inline-start" /> Back to editor
          </Button>
        ) : null}
      </div>

      {notice ? (
        <Alert>
          <AlertTitle>Saved</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Prompt packs unavailable</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {loading ? (
        <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Spinner /> Loading prompt packs…
        </p>
      ) : packs.length === 0 && !error ? (
        <Card>
          <CardHeader>
            <CardTitle>No prompt packs</CardTitle>
            <CardDescription>The application shipped no factory prompt packs.</CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
          <Card className="min-w-0 self-start">
            <CardHeader>
              <CardTitle>Game packages</CardTitle>
              <CardDescription>Select a package to inspect its prompts.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <ul className="flex flex-col gap-1.5">
                {packs.map((pack) => (
                  <li key={pack.packId}>
                    <button
                      type="button"
                      onClick={() => setSelectedPackId(pack.packId)}
                      aria-current={selectedPackId === pack.packId ? "true" : undefined}
                      className={`flex w-full min-w-0 items-center gap-2.5 rounded-sm border px-2.5 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                        selectedPackId === pack.packId
                          ? "border-ring bg-accent"
                          : "border-border bg-background hover:bg-accent"
                      }`}
                    >
                      <Gamepad2 className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium text-foreground">
                          {pack.displayName}
                        </span>
                        <span className="block text-[12px] text-muted-foreground">
                          {pack.customized.length === 0
                            ? "Factory defaults"
                            : `${pack.customized.length} customized`}
                          {pack.packId === defaultPackId ? " · Default" : ""}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>

          {selectedPack ? (
            <Card className="min-w-0">
              <CardHeader>
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle>{selectedPack.displayName}</CardTitle>
                    <CardDescription>
                      {selectedPack.customized.length === 0
                        ? "Every prompt uses its factory default."
                        : `${selectedPack.customized.length} prompt(s) customized.`}{" "}
                      Each project selects its active package in the editor Configure tab.
                    </CardDescription>
                  </div>
                  {selectedPack.customized.length > 0 ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={busy !== ""}
                      onClick={resetPack}
                    >
                      <RotateCcw data-icon="inline-start" />
                      Reset pack
                    </Button>
                  ) : null}
                </div>
              </CardHeader>
              <CardContent className="flex min-w-0 flex-col gap-5">
                {FIELD_GROUPS.map((group, index) => (
                  <div key={group.id} className="flex min-w-0 flex-col gap-3">
                    {index > 0 ? <Separator /> : null}
                    <h2 className="text-[13px] font-semibold text-foreground">{group.title}</h2>
                    {group.fields
                      .filter((field) => fieldMeta[field])
                      .map((field) => (
                        <FieldEditor
                          key={field}
                          fieldKey={field}
                          meta={fieldMeta[field]}
                          factoryText={selectedPack.fields[field] ?? ""}
                          effectiveText={selectedPack.effective[field] ?? ""}
                          customized={selectedPack.customized.includes(field)}
                          busy={busy !== ""}
                          onSave={saveField}
                        />
                      ))}
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}
        </div>
      )}
    </div>
  );
}
