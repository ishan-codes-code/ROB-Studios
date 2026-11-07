import { useCallback, useEffect, useRef, useState } from "react";
import { Check, LoaderCircle, Mic, RotateCcw, Trash2, Volume2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.jsx";
import { Badge } from "@/components/ui/badge.jsx";
import { Button } from "@/components/ui/button.jsx";
import { Separator } from "@/components/ui/separator.jsx";
import { Spinner } from "@/components/ui/spinner.jsx";
import PreviewPlayer from "../tts-studio/PreviewPlayer.jsx";
import useVoiceConfigs from "@/hooks/useVoiceConfigs.js";
import { GroupHeading } from "./ProjectConfiguration.jsx";

const selectClassName =
  "h-8 w-full rounded-sm border border-input bg-background px-2 text-[12px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const inputClassName =
  "h-8 w-full rounded-sm border border-input bg-background px-2 text-[12px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

function base64ToUrl(base64, mimeType) {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return {
    url: URL.createObjectURL(new Blob([bytes], { type: mimeType || "audio/wav" })),
    bytes: bytes.length,
  };
}

function draftFromSnapshot(snapshot) {
  return {
    model: snapshot.resolved.model,
    voice: snapshot.resolved.voice,
    voiceDirection: snapshot.resolved.voiceDirection,
    credentialId: snapshot.credentialId,
  };
}

const EMPTY_DRAFT = { model: "", voice: "", voiceDirection: "", credentialId: null };
const IDLE_PREVIEW = { status: "idle", url: null, bytes: 0, caption: "", error: "" };

/**
 * Compact project voice workspace for the editor inspector. The project
 * owns its active configuration — the open project is the scope, so
 * there is no Global/Project switch: edit and save it here, preview
 * it through the shared synthesis path, and move settings in and out
 * of the reusable library as explicit copies.
 */
export default function VoicePanel({ projectId, onNavigate }) {
  const library = useVoiceConfigs();
  const [catalog, setCatalog] = useState(null);
  const [previewPhrase, setPreviewPhrase] = useState("");
  const [ttsCredentials, setTtsCredentials] = useState([]);
  const [snapshot, setSnapshot] = useState(null);
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [presetName, setPresetName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [preview, setPreview] = useState(IDLE_PREVIEW);
  const cacheRef = useRef(new Map());

  useEffect(() => () => {
    for (const entry of cacheRef.current.values()) URL.revokeObjectURL(entry.url);
    cacheRef.current.clear();
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const [catalogResult, configResult, credentialResult] = await Promise.all([
        window.api.getTtsCatalog(),
        window.api.getTtsConfig(projectId),
        window.api.listCredentials().catch(() => null),
      ]);
      if (!catalogResult?.ok) throw new Error(catalogResult?.error ?? "Could not load the voice catalogue.");
      if (!configResult?.ok) throw new Error(configResult?.error ?? "Could not load the project voice.");
      setCatalog(catalogResult.catalog);
      setPreviewPhrase(catalogResult.previewPhrase);
      setSnapshot(configResult);
      setDraft(draftFromSnapshot(configResult));
      setTtsCredentials(
        (Array.isArray(credentialResult?.credentials) ? credentialResult.credentials : [])
          .filter((entry) => entry?.purpose === "tts"),
      );
    } catch (err) {
      setLoadError(err?.message ?? "Could not load the project voice.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    setSelectedId("");
    setPresetName("");
    setConfirmDelete(false);
    setPreview(IDLE_PREVIEW);
    setNotice("");
    setError("");
    library.clearMessage();
    load();
  }, [load, library.clearMessage]);

  const dirty = snapshot !== null && (
    draft.model !== snapshot.resolved.model
    || draft.voice !== snapshot.resolved.voice
    || draft.voiceDirection !== snapshot.resolved.voiceDirection
    || draft.credentialId !== snapshot.credentialId
  );

  const controlsDisabled = loading || library.loading || busy !== "" || library.busy !== "";

  const setDraftField = (field, value) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setNotice("");
    setError("");
  };

  const entry = library.configs.find((config) => config.id === selectedId) ?? null;
  const entryModelOk = !entry || (catalog?.models ?? []).some((model) => model.id === entry.model);
  const entryCredentialOk = !entry || entry.credentialId === null
    || ttsCredentials.some((credential) => credential.id === entry.credentialId);

  const draftCredentialMissing = draft.credentialId !== null
    && !ttsCredentials.some((credential) => credential.id === draft.credentialId);
  const draftVoiceCustom = draft.voice !== ""
    && !(catalog?.voices ?? []).some((voice) => voice.id === draft.voice);

  const applyEntry = async () => {
    if (!entry || busy || library.busy || !catalog) return;
    if (!entryModelOk) {
      setError(`“${entry.name}” uses model “${entry.model}”, which is no longer available. Pick another configuration.`);
      return;
    }
    setBusy("apply");
    setNotice("");
    setError("");
    library.clearMessage();
    try {
      const patch = { model: entry.model, voice: entry.voice, voiceDirection: entry.voiceDirection };
      const credentialUsable = entry.credentialId !== null
        && ttsCredentials.some((credential) => credential.id === entry.credentialId);
      if (credentialUsable) patch.credentialId = entry.credentialId;
      const result = await window.api.setTtsConfig({ scope: "project", projectId, patch });
      if (!result?.ok) throw new Error(result?.error ?? "Could not apply the voice configuration.");
      setSnapshot(result);
      setDraft(draftFromSnapshot(result));
      setNotice(
        credentialUsable || entry.credentialId === null
          ? `Applied “${entry.name}” to this project.`
          : `Applied “${entry.name}” voice settings; its saved credential is unavailable, so this project's credential was kept.`,
      );
    } catch (err) {
      setError(err?.message ?? "Could not apply the voice configuration.");
    } finally {
      setBusy("");
    }
  };

  const saveDraft = async () => {
    if (!snapshot || busy || library.busy) return;
    setBusy("save");
    setNotice("");
    setError("");
    try {
      const result = await window.api.setTtsConfig({
        scope: "project",
        projectId,
        patch: {
          model: draft.model,
          voice: draft.voice,
          voiceDirection: draft.voiceDirection,
          credentialId: draft.credentialId,
        },
      });
      if (!result?.ok) throw new Error(result?.error ?? "Could not save the project voice.");
      setSnapshot(result);
      setDraft(draftFromSnapshot(result));
      setNotice("Project voice saved.");
    } catch (err) {
      setError(err?.message ?? "Could not save the project voice.");
    } finally {
      setBusy("");
    }
  };

  const saveNew = async () => {
    if (busy || library.busy) return;
    const name = presetName.trim();
    if (name === "") {
      setError("Name the configuration before saving it to the library.");
      return;
    }
    const created = await library.createConfig({
      name,
      credentialId: draft.credentialId,
      model: draft.model,
      voice: draft.voice,
      voiceDirection: draft.voiceDirection,
    });
    if (created) {
      setPresetName("");
      setSelectedId(created.id);
    }
  };

  const updateSelected = async () => {
    if (!entry || busy || library.busy) return;
    await library.updateConfig(entry.id, {
      credentialId: draft.credentialId,
      model: draft.model,
      voice: draft.voice,
      voiceDirection: draft.voiceDirection,
    });
  };

  const renameSelected = async () => {
    if (!entry || busy || library.busy) return;
    const name = presetName.trim();
    if (name === "") {
      setError("Enter a name to rename the selected configuration.");
      return;
    }
    const renamed = await library.updateConfig(entry.id, { name });
    if (renamed) setPresetName("");
  };

  const deleteSelected = async () => {
    if (!entry || busy || library.busy) return;
    const ok = await library.deleteConfig(entry.id);
    if (ok) {
      setSelectedId("");
      setConfirmDelete(false);
    }
  };

  const runPreview = async () => {
    if (busy || library.busy || !previewPhrase) return;
    const cacheKey = JSON.stringify({
      text: previewPhrase,
      model: draft.model,
      voice: draft.voice,
      voiceDirection: draft.voiceDirection,
      credentialId: draft.credentialId,
      projectId,
    });
    const cached = cacheRef.current.get(cacheKey);
    if (cached) {
      setPreview({ status: "ready", url: cached.url, bytes: cached.bytes, caption: cached.caption, error: "" });
      setNotice("Replaying cached audio — no new request was made.");
      return;
    }
    setBusy("preview");
    setPreview({ status: "loading", url: null, bytes: 0, caption: "", error: "" });
    setNotice("");
    try {
      const result = await window.api.previewTts({
        text: previewPhrase,
        model: draft.model,
        voice: draft.voice,
        voiceDirection: draft.voiceDirection,
        projectId,
        credentialId: draft.credentialId,
      });
      if (!result?.ok) throw new Error(result?.error ?? "Could not generate preview audio.");
      const { url, bytes } = base64ToUrl(result.audioBase64, result.mimeType);
      const caption = `${result.config.voice} · ${result.config.model}`;
      const cache = cacheRef.current;
      if (!cache.has(cacheKey)) {
        while (cache.size >= 10) {
          const oldest = cache.keys().next().value;
          URL.revokeObjectURL(cache.get(oldest).url);
          cache.delete(oldest);
        }
      }
      cache.set(cacheKey, { url, bytes, caption });
      setPreview({ status: "ready", url, bytes, caption, error: "" });
    } catch (err) {
      setPreview({ status: "error", url: null, bytes: 0, caption: "", error: err?.message ?? "Could not generate preview audio." });
    } finally {
      setBusy("");
    }
  };

  const canPreview = !controlsDisabled && previewPhrase !== ""
    && draft.model !== "" && draft.voice !== "" && draft.voiceDirection !== ""
    && draft.credentialId !== null && !draftCredentialMissing;
  const directionLimit = catalog?.limits?.voiceDirectionMaxLength ?? 500;

  if (loading || library.loading) {
    return (
      <div className="flex min-w-0 flex-col gap-3 p-3">
        <p role="status" className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Spinner /> Loading project voice…
        </p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex min-w-0 flex-col gap-3 p-3">
        <Alert variant="destructive">
          <AlertTitle>Voice unavailable</AlertTitle>
          <AlertDescription className="min-w-0 [overflow-wrap:anywhere]">{loadError}</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-3 p-3">
      <section className="flex min-w-0 flex-col gap-2" aria-label="Project voice">
        <GroupHeading icon={Mic} title="Project voice" actionLabel="Manage credentials" onAction={() => onNavigate?.("api-keys")} />
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Badge variant={snapshot?.credential?.verified ? "secondary" : "outline"}>
            {snapshot?.credential
              ? (snapshot.credential.verified ? "Voice ready" : "Unverified")
              : "No credential"}
          </Badge>
          <span className="min-w-0 flex-1 truncate font-mono text-[10px] tabular-nums text-muted-foreground" title={`${draft.voice} · ${draft.model}`}>
            {draft.voice || "—"} · {draft.model || "—"}
          </span>
        </div>
        {(snapshot?.warnings ?? []).map((warning) => (
          <p key={warning} className="text-[11px] leading-relaxed text-muted-foreground">
            {warning}
          </p>
        ))}
      </section>

      <Separator />

      <section className="flex min-w-0 flex-col gap-2" aria-label="Voice preview">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" disabled={!canPreview} onClick={runPreview}>
            {busy === "preview" ? (
              <LoaderCircle data-icon="inline-start" className="animate-spin" />
            ) : (
              <Volume2 data-icon="inline-start" />
            )}
            Preview voice
          </Button>
          <span className="text-[11px] text-subtle">Paid synthesis of the current settings.</span>
        </div>
        {!draft.credentialId || draftCredentialMissing ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Select a TTS credential below to enable previews.
          </p>
        ) : null}
        <PreviewPlayer
          status={preview.status}
          audioUrl={preview.url}
          bytes={preview.bytes}
          caption={preview.caption}
          error={preview.error}
        />
      </section>

      <Separator />

      <section className="flex min-w-0 flex-col gap-2" aria-label="Saved voice configurations">
        <h2 className="text-[11px] font-medium text-muted-foreground">Saved configurations</h2>
        <div className="flex min-w-0 items-center gap-2">
          <select
            aria-label="Saved voice configuration"
            className={`${selectClassName} min-w-0 flex-1`}
            value={selectedId}
            disabled={controlsDisabled}
            onChange={(event) => { setSelectedId(event.target.value); setConfirmDelete(false); }}
          >
            <option value="">
              {library.configs.length === 0 ? "No saved configurations yet" : "Choose a saved configuration…"}
            </option>
            {library.configs.map((config) => (
              <option key={config.id} value={config.id}>
                {config.name}
              </option>
            ))}
          </select>
          <Button size="sm" variant="outline" disabled={!entry || controlsDisabled} onClick={applyEntry} className="shrink-0">
            {busy === "apply" ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
            Apply
          </Button>
        </div>
        {entry && !entryModelOk ? (
          <p role="alert" className="text-[11px] leading-relaxed text-destructive">
            “{entry.name}” uses model “{entry.model}”, which is no longer available.
          </p>
        ) : null}
        {entry && entryModelOk && !entryCredentialOk ? (
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Its saved credential is unavailable — applying keeps this project&apos;s credential.
          </p>
        ) : null}
        <div className="flex min-w-0 items-center gap-2">
          <input
            aria-label="Configuration name"
            placeholder="Save current settings as…"
            autoComplete="off"
            maxLength={80}
            value={presetName}
            disabled={controlsDisabled}
            onChange={(event) => setPresetName(event.target.value)}
            className={`${inputClassName} min-w-0 flex-1`}
          />
          <Button size="sm" disabled={controlsDisabled} onClick={saveNew} className="shrink-0">
            {library.busy === "voice-create" ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
            Save new
          </Button>
        </div>
        {entry ? (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {!confirmDelete ? (
              <>
                <Button size="sm" variant="ghost" disabled={controlsDisabled} onClick={updateSelected} className="px-2">
                  {library.busy === "voice-save" ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
                  Update selected
                </Button>
                <Button size="sm" variant="ghost" disabled={controlsDisabled || presetName.trim() === ""} onClick={renameSelected} className="px-2">
                  Rename
                </Button>
                <Button size="sm" variant="ghost" disabled={controlsDisabled} onClick={() => setConfirmDelete(true)} className="px-2">
                  <Trash2 data-icon="inline-start" /> Delete
                </Button>
              </>
            ) : (
              <>
                <span className="min-w-0 flex-1 text-[11px] text-muted-foreground">
                  Delete “{entry.name}”? Projects keep their own copies.
                </span>
                <Button size="sm" variant="ghost" disabled={controlsDisabled} onClick={() => setConfirmDelete(false)} className="px-2">
                  Cancel
                </Button>
                <Button size="sm" variant="destructive" disabled={controlsDisabled} onClick={deleteSelected} className="px-2">
                  {library.busy === "voice-delete" ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
                  Delete
                </Button>
              </>
            )}
          </div>
        ) : null}
      </section>

      <Separator />

      <section className="flex min-w-0 flex-col gap-2" aria-label="Voice settings">
        <h2 className="text-[11px] font-medium text-muted-foreground">Voice settings</h2>
        <label className="flex min-w-0 flex-col gap-1.5 text-[12px]">
          <span className="font-medium text-foreground">TTS credential</span>
          {ttsCredentials.length === 0 && !draft.credentialId ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              No TTS credentials yet. Add a Google Gemini TTS configuration under AI Providers.
            </p>
          ) : (
            <select
              aria-label="TTS credential"
              className={selectClassName}
              value={draft.credentialId ?? ""}
              disabled={controlsDisabled}
              onChange={(event) => setDraftField("credentialId", event.target.value === "" ? null : event.target.value)}
            >
              <option value="">No credential selected</option>
              {draftCredentialMissing ? (
                <option value={draft.credentialId}>
                  Unavailable — pick a replacement
                </option>
              ) : null}
              {ttsCredentials.map((credential) => (
                <option key={credential.id} value={credential.id}>
                  {credential.name}{credential.verification?.status === "verified" ? " · verified" : " · unverified"}
                </option>
              ))}
            </select>
          )}
        </label>
        <label className="flex min-w-0 flex-col gap-1.5 text-[12px]">
          <span className="font-medium text-foreground">Model</span>
          <select
            aria-label="TTS model"
            className={selectClassName}
            value={draft.model}
            disabled={controlsDisabled}
            onChange={(event) => setDraftField("model", event.target.value)}
          >
            {draft.model === "" ? <option value="">Select a model…</option> : null}
            {(catalog?.models ?? []).map((model) => (
              <option key={model.id} value={model.id} title={model.description || undefined}>
                {model.id}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1.5 text-[12px]">
          <span className="font-medium text-foreground">Studio voice</span>
          <select
            aria-label="Studio voice"
            className={selectClassName}
            value={draft.voice}
            disabled={controlsDisabled}
            onChange={(event) => setDraftField("voice", event.target.value)}
          >
            {draft.voice === "" ? <option value="">Select a voice…</option> : null}
            {draftVoiceCustom ? (
              <option value={draft.voice}>
                {draft.voice} · custom
              </option>
            ) : null}
            {(catalog?.voices ?? []).map((voice) => (
              <option key={voice.id} value={voice.id}>
                {voice.id}{voice.character ? ` — ${voice.character}` : ""}
              </option>
            ))}
          </select>
        </label>
        <div className="flex min-w-0 flex-col gap-1.5 text-[12px]">
          <label htmlFor="voice-direction" className="font-medium text-foreground">Delivery style</label>
          <textarea
            id="voice-direction"
            rows={3}
            value={draft.voiceDirection}
            maxLength={directionLimit + 50}
            disabled={controlsDisabled}
            onChange={(event) => setDraftField("voiceDirection", event.target.value)}
            className="min-h-16 w-full rounded-sm border border-input bg-background px-2 py-1.5 text-[12px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          />
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] tabular-nums text-subtle">
              {draft.voiceDirection.length}/{directionLimit}
            </span>
            {draft.voiceDirection.length > directionLimit ? (
              <span className="text-[11px] text-destructive">Over the limit — shorten to save.</span>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              disabled={controlsDisabled}
              onClick={() => setDraftField("voiceDirection", catalog?.defaults?.voiceDirection ?? "")}
              className="ml-auto px-2"
            >
              <RotateCcw data-icon="inline-start" /> Reset to default
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={!dirty || controlsDisabled} onClick={saveDraft}>
            {busy === "save" ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
            Save project voice
          </Button>
          {dirty ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={controlsDisabled}
              onClick={() => snapshot && setDraft(draftFromSnapshot(snapshot))}
              className="px-2"
            >
              Discard
            </Button>
          ) : null}
          <span className="ml-auto text-[11px] text-subtle">
            {dirty ? "Unsaved changes." : "Saved settings are up to date."}
          </span>
        </div>
      </section>

      {busy === "save" || busy === "apply" || library.busy !== "" ? (
        <p role="status" className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <Spinner /> {busy === "apply" ? "Applying…" : "Saving…"}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="flex items-start gap-2 text-[12px] text-muted-foreground">
          <Check className="mt-0.5 size-4 shrink-0" /> {notice}
        </p>
      ) : null}
      {library.notice ? (
        <p role="status" className="flex items-start gap-2 text-[12px] text-muted-foreground">
          <Check className="mt-0.5 size-4 shrink-0" /> {library.notice}
        </p>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription className="min-w-0 [overflow-wrap:anywhere]">{error}</AlertDescription>
        </Alert>
      ) : null}
      {library.error ? (
        <Alert variant="destructive">
          <AlertTitle>Library update failed</AlertTitle>
          <AlertDescription className="min-w-0 [overflow-wrap:anywhere]">{library.error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
