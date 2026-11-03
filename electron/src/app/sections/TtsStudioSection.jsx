import { useCallback, useEffect, useRef, useState } from "react";
import { Check, LoaderCircle, RotateCcw, Volume2 } from "lucide-react";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.jsx";
import { Separator } from "@/components/ui/separator.jsx";
import { Spinner } from "@/components/ui/spinner.jsx";
import VoicePicker from "./tts-studio/VoicePicker.jsx";
import PreviewPlayer from "./tts-studio/PreviewPlayer.jsx";

const inputClassName =
  "h-9 rounded-md border border-input bg-background px-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

const SOURCE_LABEL = {
  project: "Project override",
  global: "Global default",
  appDefault: "Application default",
};

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

function overridesFromProjectLayer(layer) {
  return {
    model: layer?.model != null,
    voice: layer?.voice != null,
    voiceDirection: layer?.voiceDirection != null,
    credentialId: layer?.credentialId != null,
  };
}

function inheritedSource(snapshot, field) {
  return snapshot.global?.[field] != null ? "global" : "appDefault";
}

/**
 * TTS Studio: voice configuration, delivery style, credential selection,
 * and paid preview generation. Every control reads the backend catalogue
 * and stored configuration; saving persists through validated IPC, and
 * previews synthesize through the real TTS client. Nothing here is mock.
 */
export default function TtsStudioSection() {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [catalog, setCatalog] = useState(null);
  const [previewPhrase, setPreviewPhrase] = useState("");
  const [textLimit, setTextLimit] = useState(500);
  const [projects, setProjects] = useState([]);
  const [ttsCredentials, setTtsCredentials] = useState([]);
  const [scopeProjectId, setScopeProjectId] = useState(null);
  const [configLoading, setConfigLoading] = useState(false);
  const [snapshot, setSnapshot] = useState(null);
  const [draft, setDraft] = useState({ model: "", voice: "", voiceDirection: "", credentialId: null });
  const [overrides, setOverrides] = useState({ model: false, voice: false, voiceDirection: false, credentialId: false });
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [customText, setCustomText] = useState("");
  const [preview, setPreview] = useState({ status: "idle", url: null, bytes: 0, caption: "", error: "" });
  const [custom, setCustom] = useState({ status: "idle", url: null, bytes: 0, caption: "", error: "" });
  const cacheRef = useRef(new Map());

  useEffect(() => () => {
    for (const entry of cacheRef.current.values()) URL.revokeObjectURL(entry.url);
    cacheRef.current.clear();
  }, []);

  const cachePreview = (key, entry) => {
    const cache = cacheRef.current;
    // Bound the cache: evict the oldest entry past a small cap so long
    // sessions cannot accumulate object URLs and decoded audio.
    if (!cache.has(key)) {
      while (cache.size >= 10) {
        const oldest = cache.keys().next().value;
        URL.revokeObjectURL(cache.get(oldest).url);
        cache.delete(oldest);
      }
    }
    cache.set(key, entry);
  };

  const loadSnapshot = useCallback(async (projectId) => {
    const result = await window.api.getTtsConfig(projectId);
    if (!result?.ok) throw new Error(result?.error ?? "Could not load TTS configuration.");
    setSnapshot(result);
    setDraft(draftFromSnapshot(result));
    setOverrides(
      projectId === null ? { model: true, voice: true, voiceDirection: true, credentialId: true } : overridesFromProjectLayer(result.project),
    );
    return result;
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [catalogResult, projectResult, credentialResult] = await Promise.all([
          window.api.getTtsCatalog(),
          window.api.listProjects().catch(() => null),
          window.api.listCredentials().catch(() => null),
        ]);
        if (!alive) return;
        if (!catalogResult?.ok) throw new Error(catalogResult?.error ?? "Could not load the voice catalogue.");
        setCatalog(catalogResult.catalog);
        setPreviewPhrase(catalogResult.previewPhrase);
        if (typeof catalogResult.textLimit === "number") setTextLimit(catalogResult.textLimit);
        setProjects(Array.isArray(projectResult?.projects) ? projectResult.projects : []);
        setTtsCredentials(
          (Array.isArray(credentialResult?.credentials) ? credentialResult.credentials : [])
            .filter((entry) => entry?.purpose === "tts"),
        );
        await loadSnapshot(null);
      } catch (err) {
        if (alive) setLoadError(err?.message ?? "Could not load the TTS Studio.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [loadSnapshot]);

  const changeScope = async (projectId) => {
    if (busy) return;
    setScopeProjectId(projectId);
    setConfigLoading(true);
    setNotice("");
    setError("");
    try {
      await loadSnapshot(projectId);
    } catch (err) {
      setError(err?.message ?? "Could not load TTS configuration.");
    } finally {
      setConfigLoading(false);
    }
  };

  const dirty = snapshot !== null && (
    draft.model !== snapshot.resolved.model
    || draft.voice !== snapshot.resolved.voice
    || draft.voiceDirection !== snapshot.resolved.voiceDirection
    || draft.credentialId !== snapshot.credentialId
    || (scopeProjectId !== null && (
      overrides.model !== (snapshot.project?.model != null)
      || overrides.voice !== (snapshot.project?.voice != null)
      || overrides.voiceDirection !== (snapshot.project?.voiceDirection != null)
      || overrides.credentialId !== (snapshot.project?.credentialId != null)
    ))
  );

  const setDraftField = (field, value) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setNotice("");
  };

  const setOverride = (field, checked) => {
    setOverrides((current) => ({ ...current, [field]: checked }));
    setNotice("");
    if (checked && snapshot) {
      // Start the new override from the currently inherited value.
      if (field === "credentialId") {
        setDraftField("credentialId", snapshot.credentialId);
      } else {
        setDraftField(field, snapshot.resolved[field]);
      }
    }
  };

  const save = async () => {
    if (!snapshot || busy) return;
    setBusy("save");
    setError("");
    setNotice("");
    try {
      let patch;
      if (scopeProjectId === null) {
        patch = {
          model: draft.model,
          voice: draft.voice,
          voiceDirection: draft.voiceDirection,
          credentialId: draft.credentialId,
        };
      } else {
        patch = {
          model: overrides.model ? draft.model : null,
          voice: overrides.voice ? draft.voice : null,
          voiceDirection: overrides.voiceDirection ? draft.voiceDirection : null,
          credentialId: overrides.credentialId ? draft.credentialId : null,
        };
      }
      const result = await window.api.setTtsConfig({
        scope: scopeProjectId === null ? "global" : "project",
        projectId: scopeProjectId,
        patch,
      });
      if (!result?.ok) throw new Error(result?.error ?? "Could not save TTS configuration.");
      setSnapshot(result);
      setDraft(draftFromSnapshot(result));
      setOverrides(
        scopeProjectId === null
          ? { model: true, voice: true, voiceDirection: true, credentialId: true }
          : overridesFromProjectLayer(result.project),
      );
      setNotice(scopeProjectId === null ? "Global TTS defaults saved." : "Project TTS overrides saved.");
    } catch (err) {
      setError(err?.message ?? "Could not save TTS configuration.");
    } finally {
      setBusy("");
    }
  };

  const reset = async () => {
    if (!snapshot || busy) return;
    setBusy("reset");
    setError("");
    setNotice("");
    try {
      const result = await window.api.setTtsConfig({
        scope: scopeProjectId === null ? "global" : "project",
        projectId: scopeProjectId,
        patch: { model: null, voice: null, voiceDirection: null, credentialId: null },
      });
      if (!result?.ok) throw new Error(result?.error ?? "Could not reset TTS configuration.");
      setSnapshot(result);
      setDraft(draftFromSnapshot(result));
      setOverrides(
        scopeProjectId === null
          ? { model: true, voice: true, voiceDirection: true, credentialId: true }
          : overridesFromProjectLayer(result.project),
      );
      setNotice(
        scopeProjectId === null
          ? "Global TTS defaults reset to application defaults."
          : "Project overrides cleared — this project now inherits everything.",
      );
    } catch (err) {
      setError(err?.message ?? "Could not reset TTS configuration.");
    } finally {
      setBusy("");
    }
  };

  const synthesize = async (kind, text) => {
    const cacheKey = JSON.stringify({
      text,
      model: draft.model,
      voice: draft.voice,
      voiceDirection: draft.voiceDirection,
      credentialId: draft.credentialId,
      projectId: scopeProjectId,
    });
    const setState = kind === "preview" ? setPreview : setCustom;
    const cached = cacheRef.current.get(cacheKey);
    if (cached) {
      setState({ status: "ready", url: cached.url, bytes: cached.bytes, caption: cached.caption, error: "" });
      setNotice("Replaying cached audio — no new request was made.");
      return;
    }
    setBusy(kind);
    setState({ status: "loading", url: null, bytes: 0, caption: "", error: "" });
    setNotice("");
    try {
      const result = await window.api.previewTts({
        text,
        model: draft.model,
        voice: draft.voice,
        voiceDirection: draft.voiceDirection,
        projectId: scopeProjectId,
        credentialId: draft.credentialId,
      });
      if (!result?.ok) throw new Error(result?.error ?? "Could not generate preview audio.");
      const { url, bytes } = base64ToUrl(result.audioBase64, result.mimeType);
      const caption = `${result.config.voice} · ${result.config.model}`;
      cachePreview(cacheKey, { url, bytes, caption });
      setState({ status: "ready", url, bytes, caption, error: "" });
    } catch (err) {
      setState({ status: "error", url: null, bytes: 0, caption: "", error: err?.message ?? "Could not generate preview audio." });
    } finally {
      setBusy("");
    }
  };

  const canPreview = !busy && !configLoading && draft.model && draft.voice && draft.voiceDirection && draft.credentialId;
  const customValid = customText.trim() !== "" && customText.length <= textLimit;
  const directionLimit = catalog?.limits?.voiceDirectionMaxLength ?? 500;

  if (loading) {
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 pb-8">
        <div className="min-w-0">
          <h1 className="text-[17px] font-semibold tracking-[-0.01em] text-foreground">Voice Providers</h1>
          <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-muted-foreground">
            Voices, delivery style, and preview generation for commentary audio.
          </p>
        </div>
        <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Spinner /> Loading voices and configuration…
        </p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 pb-8">
        <div className="min-w-0">
          <h1 className="text-[17px] font-semibold tracking-[-0.01em] text-foreground">Voice Providers</h1>
        </div>
        <Alert variant="destructive">
          <AlertTitle>Studio unavailable</AlertTitle>
          <AlertDescription className="min-w-0 [overflow-wrap:anywhere]">{loadError}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const projectScope = scopeProjectId !== null;
  const sourceCaption = (field) => {
    if (!snapshot) return "";
    if (!projectScope) return SOURCE_LABEL[snapshot.sources[field]];
    if (overrides[field]) return "Project override";
    const inherited = inheritedSource(snapshot, field);
    return inherited === "global" ? "Inherited from global defaults" : "Inherited application default";
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 pb-8">
      <div className="min-w-0">
        <h1 className="text-[17px] font-semibold tracking-[-0.01em] text-foreground">Voice Providers</h1>
        <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-muted-foreground">
          Configure the commentary voice, preview it with real synthesis, and save
          defaults. Saved settings flow into project audio generation.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Configuration scope</CardTitle>
          <CardDescription>
            Global defaults apply to every project; a project override wins over them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex min-w-0 max-w-sm flex-col gap-1.5 text-[13px]">
            <span id="tts-scope-label" className="font-medium text-foreground">Editing</span>
            <Select
              value={scopeProjectId ?? "__global"}
              disabled={!!busy || configLoading}
              onValueChange={(next) => changeScope(next === "__global" ? null : next)}
            >
              <SelectTrigger aria-labelledby="tts-scope-label" className="w-full text-[13px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__global">Global defaults (all projects)</SelectItem>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {configLoading ? (
            <p className="mt-2 flex items-center gap-2 text-[12px] text-muted-foreground">
              <Spinner /> Loading configuration…
            </p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Voice</CardTitle>
          <CardDescription>
            Model and prebuilt studio voice. Previews and generation share these exact settings.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span id="tts-model-label" className="text-[13px] font-medium text-foreground">Model</span>
              <span className="text-[11px] text-subtle">{sourceCaption("model")}</span>
              {projectScope ? (
                <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-[12px] text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={overrides.model}
                    disabled={!!busy || configLoading}
                    onChange={(event) => setOverride("model", event.target.checked)}
                    className="size-4 accent-primary"
                  />
                  Override
                </label>
              ) : null}
            </div>
            {projectScope && !overrides.model ? (
              <p className="font-mono text-[12px] text-muted-foreground">{snapshot?.resolved.model}</p>
            ) : (
              <div role="group" aria-labelledby="tts-model-label" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {catalog.models.map((model) => {
                  const selected = draft.model === model.id;
                  return (
                    <Button
                      key={model.id}
                      type="button"
                      variant={selected ? "secondary" : "outline"}
                      aria-pressed={selected}
                      disabled={!!busy || configLoading}
                      onClick={() => setDraftField("model", model.id)}
                      className="h-auto min-w-0 flex-col items-stretch gap-1.5 whitespace-normal rounded-md px-3 py-2.5 text-left"
                    >
                      <span className="flex w-full items-center justify-between gap-2">
                        <span className="truncate font-mono text-[12px] font-medium">{model.id}</span>
                        {selected ? <Check className="size-4 shrink-0 text-foreground" aria-hidden /> : null}
                      </span>
                      {model.description ? (
                        <span className="text-[11px] font-normal leading-relaxed text-muted-foreground">
                          {model.description}
                        </span>
                      ) : null}
                    </Button>
                  );
                })}
              </div>
            )}
          </div>

          <Separator />

          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span id="tts-voice-label" className="text-[13px] font-medium text-foreground">Studio voice</span>
              <span className="text-[11px] text-subtle">{sourceCaption("voice")}</span>
              {projectScope ? (
                <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-[12px] text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={overrides.voice}
                    disabled={!!busy || configLoading}
                    onChange={(event) => setOverride("voice", event.target.checked)}
                    className="size-4 accent-primary"
                  />
                  Override
                </label>
              ) : null}
            </div>
            {projectScope && !overrides.voice ? (
              <p className="text-[13px] text-muted-foreground">
                {snapshot?.resolved.voice} <span className="text-[11px] text-subtle">(inherited)</span>
              </p>
            ) : (
              <VoicePicker
                voices={catalog.voices}
                value={draft.voice}
                onChange={(voice) => setDraftField("voice", voice)}
                disabled={!!busy || configLoading}
              />
            )}
          </div>

          <Separator />

          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!canPreview}
                onClick={() => synthesize("preview", previewPhrase)}
              >
                {busy === "preview" ? (
                  <LoaderCircle data-icon="inline-start" className="animate-spin" />
                ) : (
                  <Volume2 data-icon="inline-start" />
                )}
                Preview voice
              </Button>
              <span className="text-[11px] text-subtle">
                Paid synthesis with the current settings{scopeProjectId ? " for this project" : ""}.
              </span>
            </div>
            <p className="text-[12px] italic leading-relaxed text-muted-foreground">“{previewPhrase}”</p>
            {!draft.credentialId ? (
              <p className="text-[12px] text-muted-foreground">
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
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Delivery style</CardTitle>
          <CardDescription>
            How the commentator should sound. This controls vocal delivery only — never the commentary words.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-subtle">{sourceCaption("voiceDirection")}</span>
            {projectScope ? (
              <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-[12px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={overrides.voiceDirection}
                  disabled={!!busy || configLoading}
                  onChange={(event) => setOverride("voiceDirection", event.target.checked)}
                  className="size-4 accent-primary"
                />
                Override
              </label>
            ) : null}
          </div>
          {projectScope && !overrides.voiceDirection ? (
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {snapshot?.resolved.voiceDirection} <span className="text-[11px] text-subtle">(inherited)</span>
            </p>
          ) : (
            <>
              <textarea
                aria-label="Voice direction"
                rows={3}
                value={draft.voiceDirection}
                maxLength={directionLimit + 50}
                disabled={!!busy || configLoading}
                onChange={(event) => setDraftField("voiceDirection", event.target.value)}
                className="min-h-20 rounded-md border border-input bg-background px-3 py-2 text-[13px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
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
                  disabled={!!busy || configLoading}
                  onClick={() => setDraftField("voiceDirection", catalog.defaults.voiceDirection)}
                  className="ml-auto"
                >
                  <RotateCcw data-icon="inline-start" /> Reset to default
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>TTS credential</CardTitle>
          <CardDescription>
            Keys stay encrypted in the vault; only names and verification reach this page.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-subtle">
              {projectScope
                ? (overrides.credentialId ? "Project override" : "Inherited")
                : (snapshot?.credentialId ? SOURCE_LABEL[snapshot.credentialSource] : "None selected")}
            </span>
            {projectScope ? (
              <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-[12px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={overrides.credentialId}
                  disabled={!!busy || configLoading}
                  onChange={(event) => setOverride("credentialId", event.target.checked)}
                  className="size-4 accent-primary"
                />
                Override
              </label>
            ) : null}
          </div>
          {projectScope && !overrides.credentialId ? (
            <p className="text-[13px] text-muted-foreground">
              {snapshot?.credential ? snapshot.credential.name : "None configured"}{" "}
              <span className="text-[11px] text-subtle">(inherited)</span>
            </p>
          ) : ttsCredentials.length === 0 ? (
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              No TTS credentials yet. Add a Google Gemini TTS configuration under AI Providers.
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={draft.credentialId ?? "__none"}
                disabled={!!busy || configLoading}
                onValueChange={(next) => setDraftField("credentialId", next === "__none" ? null : next)}
              >
                <SelectTrigger aria-label="TTS credential" className="min-w-0 max-w-sm flex-1 text-[13px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none">No credential selected</SelectItem>
                  {ttsCredentials.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {entry.name}{entry.verification?.status === "verified" ? " (verified)" : " (unverified)"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {snapshot?.credential ? (
                <Badge variant={snapshot.credential.verified ? "secondary" : "outline"}>
                  {snapshot.credential.verified ? "Verified" : "Unverified"}
                </Badge>
              ) : null}
            </div>
          )}
          {(snapshot?.warnings ?? []).map((warning) => (
            <p key={warning} className="text-[12px] leading-relaxed text-muted-foreground">
              {warning}
            </p>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Test bench</CardTitle>
          <CardDescription>
            Generate a sample from any text with the current settings. Never touches scripts or manifests.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <textarea
            aria-label="Custom test text"
            rows={3}
            value={customText}
            maxLength={textLimit + 50}
            placeholder="Type commentary to hear it in this voice…"
            disabled={!!busy || configLoading}
            onChange={(event) => setCustomText(event.target.value)}
            className="min-h-20 rounded-md border border-input bg-background px-3 py-2 text-[13px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          />
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-[11px] tabular-nums text-subtle">
              {customText.length}/{textLimit}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={!canPreview || !customValid}
              onClick={() => synthesize("custom", customText)}
              className="ml-auto"
            >
              {busy === "custom" ? (
                <LoaderCircle data-icon="inline-start" className="animate-spin" />
              ) : (
                <Volume2 data-icon="inline-start" />
              )}
              Generate sample
            </Button>
          </div>
          <PreviewPlayer
            status={custom.status}
            audioUrl={custom.url}
            bytes={custom.bytes}
            caption={custom.caption}
            error={custom.error}
          />
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={!dirty || !!busy || configLoading} onClick={save}>
          {busy === "save" ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
          {projectScope ? "Save project overrides" : "Save global defaults"}
        </Button>
        <Button size="sm" variant="outline" disabled={!!busy || configLoading} onClick={reset}>
          {busy === "reset" ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
          {projectScope ? "Reset to inherited" : "Reset to application defaults"}
        </Button>
        <span className="ml-auto text-[11px] text-subtle">
          {dirty ? "Unsaved changes." : "Saved settings are up to date."}
        </span>
      </div>

      <Separator />
      {notice ? (
        <p role="status" className="flex items-start gap-2 text-[13px] text-muted-foreground">
          <Check className="mt-0.5 size-4 shrink-0" /> {notice}
        </p>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription className="min-w-0 [overflow-wrap:anywhere]">{error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
