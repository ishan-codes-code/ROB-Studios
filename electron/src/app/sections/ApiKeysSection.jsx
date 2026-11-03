import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  Check,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Wifi,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.jsx";
import { Badge } from "@/components/ui/badge.jsx";
import { Button } from "@/components/ui/button.jsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.jsx";
import { Separator } from "@/components/ui/separator.jsx";
import { Skeleton } from "@/components/ui/skeleton.jsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.jsx";
import useCredentials from "@/hooks/useCredentials.js";
import ProviderStatusBadge from "@/app/sections/providers/ProviderStatusBadge.jsx";
import ModelPicker from "@/app/sections/providers/ModelPicker.jsx";
import {
  validateEndpointInput,
  validateKeyInput,
  validateModelInput,
  validateName,
} from "@/lib/config-validation.js";

const PROVIDER_OPTIONS = [
  { id: "meta", name: "Meta", blurb: "Curated Muse models over the Meta Model API.", vision: true },
  { id: "baseten", name: "Baseten", blurb: "Muse Spark Open on Baseten infrastructure.", vision: true },
  { id: "custom", name: "Custom", blurb: "Your own OpenAI-compatible endpoint, explicitly verified.", vision: true },
  { id: "google-gemini-tts", name: "Gemini TTS", blurb: "Google speech access only — no vision, no model.", vision: false },
];

const PROVIDER_LABEL = {
  meta: "Meta",
  baseten: "Baseten",
  custom: "Custom",
  "google-gemini-tts": "Gemini TTS",
};

function providerLabel(id) {
  return PROVIDER_LABEL[id] ?? id;
}

function formatTimestamp(value) {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";
  return date.toLocaleString();
}

function Field({ label, children, hint }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-[13px]">
      <span className="font-medium text-foreground">{label}</span>
      {children}
      {hint ? <span className="text-[12px] text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

const inputClassName =
  "h-9 rounded-md border border-input bg-background px-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

/**
 * AI Providers management: named Meta / Baseten / custom vision
 * configurations plus Gemini TTS speech credentials. Keys stay
 * encrypted in the main-process vault; the renderer sees presence and
 * verification state only. Connection tests and image verification are
 * explicit, separate, user-triggered operations.
 */
export default function ApiKeysSection({ onBackToEditor }) {
  const { credentials, secureStorage, devBypass, migration, loading, error: loadError, reload } = useCredentials();
  const [connectedIds, setConnectedIds] = useState(() => new Set());
  const [failedIds, setFailedIds] = useState(() => new Set());
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [provider, setProvider] = useState("meta");
  const [curated, setCurated] = useState([]);
  const [curatedLoading, setCuratedLoading] = useState(false);
  const [form, setForm] = useState({ name: "", key: "", baseUrl: "", model: "" });
  const [pickerError, setPickerError] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const [editKey, setEditKey] = useState("");
  const [editEndpoint, setEditEndpoint] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const selected = credentials.find((entry) => entry.id === selectedId) ?? null;

  useEffect(() => {
    if (migration?.notice) setNotice(migration.notice);
  }, [migration]);

  useEffect(() => {
    const needMeta = (adding && provider === "meta") || selected?.provider === "meta";
    if (!needMeta) return;
    let alive = true;
    setCuratedLoading(true);
    window.api.providerModels("meta").then((result) => {
      if (alive) setCurated(result?.models ?? []);
    }).catch(() => {
      if (alive) setCurated([]);
    }).finally(() => {
      if (alive) setCuratedLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [adding, provider, selected?.provider]);

  useEffect(() => {
    setEditEndpoint(selected?.baseUrl ?? "");
    setEditKey("");
    setConfirmDelete(false);
  }, [selected?.id, selected?.baseUrl]);

  const markConnected = useCallback((id, ok) => {
    setConnectedIds((current) => {
      const next = new Set(current);
      if (ok) next.add(id);
      else next.delete(id);
      return next;
    });
    setFailedIds((current) => {
      const next = new Set(current);
      if (ok) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setBypass = useCallback(async (enabled) => {
    setError("");
    setNotice("");
    try {
      const result = await window.api.setDevBypass(enabled);
      if (!result?.ok) throw new Error(result?.error ?? "Could not change the development bypass.");
      setNotice(
        result.enabled === true
          ? "Development credential mode active — credentials are held in memory only and will be cleared when the application closes."
          : "Development credential mode disabled. Secure storage is required again.",
      );
      await reload();
    } catch (err) {
      setError(err?.message ?? "Could not change the development bypass.");
    }
  }, [reload]);

  const startAdd = useCallback(() => {
    setAdding(true);
    setError("");
    setNotice("");
    setPickerError("");
    setProvider("meta");
    setForm({ name: "", key: "", baseUrl: "", model: "" });
  }, []);

  const createConfiguration = useCallback(async () => {
    setBusy("create");
    setError("");
    setNotice("");
    try {
      const nameError = validateName(form.name, "Configuration name");
      if (nameError) throw new Error(nameError);
      const keyError = validateKeyInput(form.key);
      if (keyError) throw new Error(keyError);
      const model = provider === "baseten" ? "meta-models/muse-spark-open"
        : provider === "google-gemini-tts" ? null : form.model.trim();
      if (provider === "custom") {
        const urlError = validateEndpointInput(form.baseUrl);
        if (urlError) throw new Error(urlError);
        const modelError = validateModelInput(model);
        if (modelError) throw new Error("Select a discovered model or enter one manually.");
      } else if (provider === "meta") {
        if (!model) throw new Error("Select a supported Meta model.");
      }
      const result = await window.api.createCredential({
        name: form.name.trim(),
        provider,
        model,
        key: form.key,
        ...(provider === "custom" ? { baseUrl: form.baseUrl.trim() } : {}),
      });
      if (!result?.ok) throw new Error("Could not save the provider. The name may already be in use.");
      setNotice(provider === "google-gemini-tts"
        ? `Saved “${result.credential.name}”. Test access to check Gemini TTS model metadata.`
        : `Saved “${result.credential.name}”. Test the connection, then verify image support before paid runs.`);
      setAdding(false);
      setForm({ name: "", key: "", baseUrl: "", model: "" });
      await reload();
      setSelectedId(result.credential.id);
    } catch (err) {
      setError(err?.message ?? "Could not save the provider.");
    } finally {
      setBusy("");
    }
  }, [form, provider, reload]);

  const runCheck = useCallback(async (kind) => {
    if (!selectedId) return;
    setBusy(kind);
    setError("");
    setNotice("");
    try {
      const ttsCredential = selected?.purpose === "tts";
      const action = kind === "connection" && !ttsCredential
        ? window.api.testCredential
        : window.api.verifyCredential;
      const result = await action(selectedId);
      if (!result?.ok) {
        const detail = typeof result?.detail === "string" && result.detail ? ` (detail: ${result.detail})` : "";
        throw new Error(`${result?.error ?? "Provider request failed. Check the key, model, and provider compatibility."}${detail}`);
      }
      if (ttsCredential) {
        markConnected(selectedId, true);
        setNotice("Google API key authenticated and Gemini TTS model metadata is available. Speech generation access was not tested.");
      } else if (kind === "verify") {
        setNotice("Image input verified for the selected key and model.");
      } else {
        markConnected(selectedId, true);
        setNotice("Connection succeeded. Image support still needs explicit verification.");
      }
      await reload();
    } catch (err) {
      markConnected(selectedId, false);
      setError(err?.message ?? "Provider request failed. Check the key, model, and provider compatibility.");
    } finally {
      setBusy("");
    }
  }, [markConnected, reload, selected, selectedId]);

  const replaceKey = useCallback(async () => {
    if (!selectedId || !editKey) return;
    setBusy("key");
    setError("");
    setNotice("");
    try {
      const keyError = validateKeyInput(editKey);
      if (keyError) throw new Error(keyError);
      const result = await window.api.setCredentialKey(selectedId, editKey);
      if (!result?.ok) throw new Error("Could not replace the API key.");
      markConnected(selectedId, false);
      setFailedIds((current) => {
        const next = new Set(current);
        next.delete(selectedId);
        return next;
      });
      setNotice(selected?.purpose === "tts"
        ? "Key replaced. TTS access check was reset — test again."
        : "Key replaced. Image verification was reset — verify again before paid runs.");
      setEditKey("");
      await reload();
    } catch (err) {
      setError(err?.message ?? "Could not replace the API key.");
    } finally {
      setBusy("");
    }
  }, [editKey, markConnected, reload, selected, selectedId]);

  const changeModel = useCallback(async (model) => {
    if (!selectedId || !model || model === selected?.model) return;
    setBusy("model");
    setError("");
    setNotice("");
    try {
      const result = await window.api.setCredentialModel(selectedId, model);
      if (!result?.ok) throw new Error("Could not change the model.");
      markConnected(selectedId, false);
      setFailedIds((current) => {
        const next = new Set(current);
        next.delete(selectedId);
        return next;
      });
      setNotice("Model changed. Image verification was reset — verify again before paid runs.");
      await reload();
    } catch (err) {
      setError(err?.message ?? "Could not change the model.");
    } finally {
      setBusy("");
    }
  }, [markConnected, reload, selected, selectedId]);

  const changeEndpoint = useCallback(async () => {
    if (!selectedId || !editEndpoint || editEndpoint === selected?.baseUrl) return;
    setBusy("endpoint");
    setError("");
    setNotice("");
    try {
      const urlError = validateEndpointInput(editEndpoint);
      if (urlError) throw new Error(urlError);
      const result = await window.api.setCredentialEndpoint(selectedId, editEndpoint.trim());
      if (!result?.ok) throw new Error("Could not change the endpoint.");
      markConnected(selectedId, false);
      setFailedIds((current) => {
        const next = new Set(current);
        next.delete(selectedId);
        return next;
      });
      setNotice("Endpoint changed. Image verification was reset — verify again before paid runs.");
      await reload();
    } catch (err) {
      setError(err?.message ?? "Could not change the endpoint.");
    } finally {
      setBusy("");
    }
  }, [editEndpoint, markConnected, reload, selected, selectedId]);

  const rename = useCallback(async (name) => {
    if (!selectedId || !name.trim() || name.trim() === selected?.name) return;
    setBusy("rename");
    setError("");
    try {
      const nameError = validateName(name, "Configuration name");
      if (nameError) throw new Error(nameError);
      const result = await window.api.renameCredential(selectedId, name.trim());
      if (!result?.ok) throw new Error("Could not rename the provider.");
      await reload();
    } catch (err) {
      setError(err?.message ?? "Could not rename the provider.");
    } finally {
      setBusy("");
    }
  }, [reload, selected, selectedId]);

  const remove = useCallback(async () => {
    if (!selectedId) return;
    setBusy("delete");
    setError("");
    try {
      const result = await window.api.removeCredential(selectedId);
      if (!result?.ok) {
        if (Array.isArray(result?.referencedBy) && result.referencedBy.length > 0) {
          throw new Error(`In use by ${result.referencedBy.length} project(s): ${result.referencedBy.slice(0, 3).join(", ")}. Change those projects first.`);
        }
        if (result?.referencedByGlobal === true) {
          throw new Error("Used as the global TTS default. Choose another TTS credential in the TTS Studio first.");
        }
        throw new Error("Could not delete the provider.");
      }
      setNotice("Provider deleted.");
      setSelectedId(null);
      setConfirmDelete(false);
      await reload();
    } catch (err) {
      setError(err?.message ?? "Could not delete the provider.");
    } finally {
      setBusy("");
    }
  }, [reload, selectedId]);

  const formModelValid = provider === "google-gemini-tts" || provider === "baseten"
    ? true
    : provider === "meta"
      ? form.model !== ""
      : validateEndpointInput(form.baseUrl) === null && validateModelInput(form.model) === null;
  const formValid = validateName(form.name, "Configuration name") === null
    && validateKeyInput(form.key) === null
    && formModelValid;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 pb-8">
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[17px] font-semibold tracking-[-0.01em] text-foreground">AI Providers</h1>
          <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-muted-foreground">
            Named vision configurations for Meta, Baseten, and custom endpoints, plus Gemini
            speech credentials. Keys stay encrypted on this device — only presence and
            verification status are shown.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onBackToEditor ? (
            <Button variant="outline" size="sm" onClick={onBackToEditor}>
              <ArrowLeft data-icon="inline-start" /> Back to editor
            </Button>
          ) : null}
          <Button size="sm" onClick={startAdd} disabled={adding || loading || !!busy}>
            <Plus data-icon="inline-start" /> Add provider
          </Button>
        </div>
      </div>

      {!secureStorage ? (
        <Alert variant="destructive">
          <AlertTitle>Secure storage unavailable</AlertTitle>
          <AlertDescription>
            This device cannot encrypt credentials, so providers cannot be saved or read.
            Resolve OS keychain access, then reload this page.
          </AlertDescription>
        </Alert>
      ) : null}

      {devBypass.supported && !secureStorage ? (
        <label className="flex min-w-0 cursor-pointer items-start gap-2 rounded-sm border border-border bg-background px-3 py-2.5">
          <input
            type="checkbox"
            checked={devBypass.enabled}
            disabled={loading || !!busy}
            onChange={(event) => setBypass(event.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-primary disabled:opacity-50"
          />
          <span className="min-w-0">
            <span className="block text-[13px] font-medium text-foreground">
              Allow insecure development credentials
            </span>
            <span className="block text-[11px] leading-relaxed text-muted-foreground">
              When enabled, credentials are kept temporarily in memory if secure OS storage
              is unavailable. They are never persisted and are cleared when the application closes.
            </span>
          </span>
        </label>
      ) : null}

      {devBypass.enabled ? (
        <Alert>
          <AlertTitle>Development credential mode active</AlertTitle>
          <AlertDescription>
            Development credential mode active — credentials are held in memory only and will
            be cleared when the application closes.
          </AlertDescription>
        </Alert>
      ) : null}

      {migration && !migration.migrated ? (
        <Alert>
          <AlertTitle>Migration notice</AlertTitle>
          <AlertDescription>{migration.notice}</AlertDescription>
        </Alert>
      ) : null}

      <Dialog open={adding} onOpenChange={(open) => {
        if (open) setAdding(true);
        else if (!busy) setAdding(false);
      }}>
        <DialogContent
          showCloseButton={!busy}
          className="flex max-h-[calc(100vh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[34rem]"
        >
          <DialogHeader className="gap-3 border-b border-border px-6 py-5 pr-14 text-left">
            <div className="flex items-start gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
                <KeyRound className="size-4 text-muted-foreground" aria-hidden />
              </span>
              <div className="flex min-w-0 flex-col gap-1">
                <DialogTitle className="text-[15px] tracking-tight">New AI provider</DialogTitle>
                <DialogDescription className="text-[12px] leading-relaxed">
                  Save a provider key for vision analysis or speech access. You can test it after creation.
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              createConfiguration();
            }}
            className="flex min-h-0 flex-1 flex-col"
          >
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              <div className="flex flex-col gap-5">
                <div className="flex flex-col gap-2">
                  <span id="provider-choice-label" className="text-[12px] font-medium text-foreground">Provider</span>
                  <div role="group" aria-labelledby="provider-choice-label" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {PROVIDER_OPTIONS.map((option) => (
                      <Button
                        key={option.id}
                        type="button"
                        variant={provider === option.id ? "secondary" : "outline"}
                        aria-pressed={provider === option.id}
                        onClick={() => {
                          setProvider(option.id);
                          setPickerError("");
                          setForm((current) => ({ ...current, model: "" }));
                        }}
                        className="h-auto min-w-0 flex-col items-stretch gap-2 whitespace-normal rounded-md px-3 py-3 text-left"
                      >
                        <span className="flex w-full items-center justify-between gap-2">
                          <span className="truncate text-[13px] font-medium">{option.name}</span>
                          {provider === option.id ? <Check className="size-4 shrink-0 text-foreground" aria-hidden /> : null}
                        </span>
                        <span className="text-[11px] font-normal leading-relaxed text-muted-foreground">{option.blurb}</span>
                      </Button>
                    ))}
                  </div>
                </div>
                <Field label="Configuration name" hint="A label to recognize this key on this device.">
                  <input
                    className={`${inputClassName} h-10`}
                    value={form.name}
                    maxLength={80}
                    placeholder="e.g. Meta Personal"
                    autoComplete="off"
                    onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                  />
                </Field>
                {provider === "custom" ? (
                  <Field label="API base URL" hint="Public HTTPS endpoint. Local and private networks are blocked.">
                    <input
                      className={`${inputClassName} h-10 font-mono`}
                      value={form.baseUrl}
                      placeholder="https://llm.example.com/v1"
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => setForm((current) => ({ ...current, baseUrl: event.target.value }))}
                    />
                  </Field>
                ) : null}
                <Field label="API key" hint="Encrypted on this device and never shown again.">
                  <input
                    type="password"
                    autoComplete="new-password"
                    className={`${inputClassName} h-10 font-mono`}
                    value={form.key}
                    placeholder="Paste the provider key"
                    onChange={(event) => setForm((current) => ({ ...current, key: event.target.value }))}
                  />
                </Field>
                {provider === "google-gemini-tts" ? (
                  <p className="text-[12px] leading-relaxed text-muted-foreground">
                    This configuration is for speech access only. No model selection or speech generation is performed here.
                  </p>
                ) : (
                  <ModelPicker
                    provider={provider}
                    value={form.model}
                    onSelect={(id) => setForm((current) => ({ ...current, model: id }))}
                    discoveryInput={provider === "custom" ? { baseUrl: form.baseUrl, key: form.key } : null}
                    curatedModels={curated}
                    curatedLoading={curatedLoading}
                    disabled={!!busy}
                    onError={setPickerError}
                  />
                )}
                {pickerError ? (
                  <Alert variant="destructive">
                    <AlertTitle>Model discovery failed</AlertTitle>
                    <AlertDescription>{pickerError}</AlertDescription>
                  </Alert>
                ) : null}
                {error ? (
                  <Alert variant="destructive">
                    <AlertTitle>Could not save provider</AlertTitle>
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                ) : null}
              </div>
            </div>
            <div className="flex flex-col gap-3 border-t border-border bg-card px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <ShieldCheck className="size-4 shrink-0" aria-hidden />
                {devBypass.enabled && !secureStorage
                  ? "Held in memory only — cleared on quit"
                  : "Encrypted on this device"}
              </p>
              <DialogFooter className="gap-2 sm:flex-row">
                <Button type="button" size="sm" variant="outline" onClick={() => setAdding(false)} disabled={!!busy}>
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={!!busy || !formValid}>
                  {busy === "create" ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
                  Save provider
                </Button>
              </DialogFooter>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader>
          <CardTitle>Saved providers</CardTitle>
          <CardDescription>
            {credentials.length === 0
              ? "No providers yet."
              : `${credentials.length} provider${credentials.length === 1 ? "" : "s"}. Saved keys are never shown.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {loading ? (
            <div className="flex flex-col gap-2" aria-label="Loading providers">
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          ) : loadError ? (
            <Alert variant="destructive">
              <AlertTitle>Could not load providers</AlertTitle>
              <AlertDescription>{loadError}</AlertDescription>
            </Alert>
          ) : credentials.length === 0 ? (
            <div className="flex flex-col items-start gap-2 rounded-sm border border-border bg-background px-3 py-4">
              <p className="text-[13px] font-medium text-foreground">No AI providers</p>
              <p className="max-w-md text-[12px] leading-relaxed text-muted-foreground">
                Add a Meta, Baseten, or custom configuration for paid vision analysis, or Gemini
                TTS for speech access. Offline frame extraction remains available without vision setup.
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {credentials.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId((current) => (current === entry.id ? null : entry.id))}
                    aria-current={selectedId === entry.id ? "true" : undefined}
                    className={`flex w-full min-w-0 items-center gap-3 rounded-sm border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      selectedId === entry.id
                        ? "border-ring bg-accent"
                        : "border-border bg-background hover:bg-accent"
                    }`}
                  >
                    <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-foreground">
                        {entry.name}
                      </span>
                      <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                        {providerLabel(entry.provider)}
                        {entry.purpose === "tts" ? " · speech access" : ` · ${entry.model}`}
                        {entry.provider === "custom" && entry.baseUrl ? ` · ${entry.baseUrl}` : ""}
                      </span>
                    </span>
                    {entry.devOnly === true ? <Badge variant="outline">In-memory (dev)</Badge> : null}
                    <ProviderStatusBadge credential={entry} connectedIds={connectedIds} failedIds={failedIds} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {selected ? (
        <ProviderDetail
          credential={selected}
          busy={busy}
          connected={connectedIds.has(selected.id)}
          editKey={editKey}
          setEditKey={setEditKey}
          editEndpoint={editEndpoint}
          setEditEndpoint={setEditEndpoint}
          confirmDelete={confirmDelete}
          setConfirmDelete={setConfirmDelete}
          curated={curated}
          curatedLoading={curatedLoading}
          onTest={() => runCheck("connection")}
          onVerify={() => runCheck("verify")}
          onReplaceKey={replaceKey}
          onChangeModel={changeModel}
          onChangeEndpoint={changeEndpoint}
          onRename={rename}
          onRemove={remove}
          onClose={() => {
            setSelectedId(null);
            setConfirmDelete(false);
          }}
        />
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
      {error && !adding ? (
        <Alert variant="destructive">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function ProviderDetail({
  credential,
  busy,
  editKey,
  setEditKey,
  editEndpoint,
  setEditEndpoint,
  confirmDelete,
  setConfirmDelete,
  curated,
  curatedLoading,
  onTest,
  onVerify,
  onReplaceKey,
  onChangeModel,
  onChangeEndpoint,
  onRename,
  onRemove,
  onClose,
}) {
  const [name, setName] = useState(credential.name);
  const [modelDraft, setModelDraft] = useState(credential.model ?? "");
  const [pickerError, setPickerError] = useState("");
  useEffect(() => {
    setName(credential.name);
    setModelDraft(credential.model ?? "");
    setPickerError("");
  }, [credential.id, credential.name, credential.model]);

  const isTts = credential.purpose === "tts";
  const commitModel = (id) => {
    setModelDraft(id);
    if (id && id !== credential.model) onChangeModel(id);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{credential.name}</CardTitle>
        <CardDescription>
          {providerLabel(credential.provider)}
          {isTts ? (
            " · speech access"
          ) : (
            <> · <span className="font-mono">{credential.model}</span>
              {credential.provider === "custom" && credential.baseUrl ? (
                <> · <span className="font-mono">{credential.baseUrl}</span></>
              ) : null}
            </>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <ProviderStatusBadge credential={credential} />
          {credential.devOnly === true ? <Badge variant="outline">In-memory (dev)</Badge> : null}
          <span className="text-[12px] text-muted-foreground">
            {credential.devOnly === true && credential.keyAvailable
              ? "Held in memory only — cleared on quit"
              : credential.keyAvailable ? "Credential stored securely" : "Stored key cannot be read"}
            {" · "}verified {formatTimestamp(credential.verification?.verifiedAt)}
          </span>
        </div>
        <Separator />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={!!busy} onClick={onTest}>
            {busy === "connection" ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <Wifi data-icon="inline-start" />}
            {busy === "connection" && isTts ? "Verifying…" : isTts ? "Test access" : "Test connection"}
          </Button>
          {!isTts ? (
            <Button size="sm" variant="outline" disabled={!!busy} onClick={onVerify}>
              {busy === "verify" ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <ShieldCheck data-icon="inline-start" />}
              Verify image support
            </Button>
          ) : null}
        </div>
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          {isTts
            ? "Checks Google API authentication and access to Gemini TTS model metadata. It does not generate speech or confirm inference entitlement."
            : "Verification sends one minimal image request with this exact key and model and can incur provider charges. It is never run automatically and is invalidated whenever the key, model, or endpoint changes."}
        </p>
        <Separator />
        <div className="flex flex-col gap-1.5 text-[13px]">
          <span className="font-medium text-foreground">Configuration name</span>
          <div className="flex gap-2">
            <input
              className={`${inputClassName} min-w-0 flex-1`}
              value={name}
              maxLength={80}
              disabled={!!busy}
              onChange={(event) => setName(event.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!!busy || !name.trim() || name.trim() === credential.name}
              onClick={() => onRename(name)}
            >
              <Pencil data-icon="inline-start" /> Rename
            </Button>
          </div>
        </div>
        {!isTts && credential.provider === "custom" ? (
          <div className="flex flex-col gap-1.5 text-[13px]">
            <span className="font-medium text-foreground">API base URL</span>
            <div className="flex gap-2">
              <input
                className={`${inputClassName} min-w-0 flex-1 font-mono`}
                value={editEndpoint}
                spellCheck={false}
                autoComplete="off"
                disabled={!!busy}
                onChange={(event) => setEditEndpoint(event.target.value)}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!!busy || !editEndpoint || editEndpoint === credential.baseUrl}
                onClick={onChangeEndpoint}
              >
                <RefreshCw data-icon="inline-start" /> Update
              </Button>
            </div>
            <span className="text-[12px] text-muted-foreground">Changing the endpoint resets image verification.</span>
          </div>
        ) : null}
        {!isTts ? (
          credential.provider === "custom" ? (
            <div className="flex flex-col gap-1.5 text-[13px]">
              <span className="font-medium text-foreground">Model</span>
              <ModelPicker
                provider="custom"
                value={modelDraft}
                onSelect={commitModel}
                discoveryInput={{ credentialId: credential.id }}
                disabled={!!busy}
                onError={setPickerError}
              />
              <span className="text-[12px] text-muted-foreground">Changing the model resets image verification.</span>
            </div>
          ) : credential.provider === "baseten" ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium text-foreground">Model</span>
              <div className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2.5">
                <code className="truncate font-mono text-[11px] text-foreground">meta-models/muse-spark-open</code>
                <Badge variant="outline" className="shrink-0">Pinned</Badge>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5 text-[13px]">
              <ModelPicker
                provider="meta"
                value={modelDraft}
                onSelect={commitModel}
                curatedModels={curated}
                curatedLoading={curatedLoading}
                disabled={!!busy}
                onError={() => {}}
              />
              <span className="text-[12px] text-muted-foreground">Changing the model resets image verification.</span>
            </div>
          )
        ) : null}
        {pickerError ? (
          <Alert variant="destructive">
            <AlertTitle>Model discovery failed</AlertTitle>
            <AlertDescription>{pickerError}</AlertDescription>
          </Alert>
        ) : null}
        <Field label="Replace API key" hint="Write-only. Replacing the key resets verification.">
          <div className="flex gap-2">
            <input
              type="password"
              autoComplete="new-password"
              className={`${inputClassName} min-w-0 flex-1`}
              value={editKey}
              placeholder="Paste the new key"
              disabled={!!busy}
              onChange={(event) => setEditKey(event.target.value)}
            />
            <Button size="sm" variant="outline" disabled={!!busy || !editKey} onClick={onReplaceKey}>
              <RefreshCw data-icon="inline-start" /> Replace
            </Button>
          </div>
        </Field>
        <Separator />
        {!confirmDelete ? (
          <div>
            <Button size="sm" variant="outline" disabled={!!busy} onClick={() => setConfirmDelete(true)}>
              <Trash2 data-icon="inline-start" /> Delete provider
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 rounded-sm border border-border bg-background px-3 py-2.5">
            <p className="mr-auto text-[12px] text-muted-foreground">
              Delete “{credential.name}”? Projects using it must choose another provider first.
            </p>
            <Button size="sm" variant="outline" disabled={!!busy} onClick={() => setConfirmDelete(false)}>
              Keep
            </Button>
            <Button size="sm" variant="destructive" disabled={!!busy} onClick={onRemove}>
              <Trash2 data-icon="inline-start" /> Delete
            </Button>
          </div>
        )}
        <Button size="sm" variant="outline" className="self-start" onClick={onClose}>
          Close details
        </Button>
      </CardContent>
    </Card>
  );
}
