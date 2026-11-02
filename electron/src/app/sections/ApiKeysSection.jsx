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
import { Spinner } from "@/components/ui/spinner.jsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.jsx";

const PROVIDER_META = {
  meta: { displayName: "Meta Model API" },
  baseten: { displayName: "Baseten" },
  "google-gemini-tts": { displayName: "Google Gemini TTS" },
};

function providerLabel(id) {
  return PROVIDER_META[id]?.displayName ?? id;
}

function statusBadge(credential) {
  if (!credential.keyAvailable) {
    return <Badge variant="destructive">Key unreadable</Badge>;
  }
  if (credential.verificationFailed) {
    return <Badge variant="destructive">Verification failed</Badge>;
  }
  if (credential.verification?.status === "verified") {
    return <Badge variant="secondary">{credential.purpose === "tts" ? "TTS access checked" : "Vision verified"}</Badge>;
  }
  return <Badge variant="outline">Saved, not tested</Badge>;
}

function credentialTarget(credential) {
  return credential.purpose === "tts" ? "TTS API key" : credential.model;
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

export default function ApiKeysSection({ onBackToEditor, embedded = false }) {
  const [credentials, setCredentials] = useState([]);
  const [secureStorage, setSecureStorage] = useState(true);
  const [migration, setMigration] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [verificationFailures, setVerificationFailures] = useState([]);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const [provider, setProvider] = useState("meta");
  const [models, setModels] = useState([]);
  const [form, setForm] = useState({ name: "", key: "", model: "" });
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [editKey, setEditKey] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await window.api.listCredentials();
      if (!result?.ok) throw new Error("Could not load API configurations.");
      setCredentials(result.credentials ?? []);
      setSecureStorage(result.secureStorageAvailable !== false);
      setMigration(result.migration ?? null);
      if (result.migration?.notice) setNotice(result.migration.notice);
    } catch (err) {
      setError(err?.message ?? "Could not load API configurations.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      await reload();
      if (!alive) return;
      try {
        const meta = await window.api.providerModels("meta");
        if (meta?.ok) setModels(meta.models ?? []);
      } catch {
        // Model list is best-effort; creation validates server-side.
      }
    })();
    return () => {
      alive = false;
    };
  }, [reload]);

  const openDetail = useCallback(
    async (id) => {
      setSelectedId(id);
      setDetail(null);
      setEditKey("");
      setConfirmDelete(false);
      setError("");
      const found = credentials.find((entry) => entry.id === id);
      setDetail(found ?? null);
    },
    [credentials],
  );

  const selected = detail ?? credentials.find((entry) => entry.id === selectedId) ?? null;

  const startAdd = useCallback(async () => {
    setAdding(true);
    setError("");
    setNotice("");
    setProvider("meta");
    setForm({ name: "", key: "", model: "" });
    try {
      const meta = await window.api.providerModels("meta");
      if (meta?.ok) setModels(meta.models ?? []);
    } catch {
      // Creation validates the model server-side regardless.
    }
  }, []);

  const createConfiguration = useCallback(async () => {
    setBusy("create");
    setError("");
    setNotice("");
    try {
      const catalog = await window.api.providerModels(provider);
      const available = catalog?.models ?? (provider === "meta" ? models : [{ id: "meta-models/muse-spark-open" }]);
      const model = provider === "baseten" ? "meta-models/muse-spark-open"
        : provider === "google-gemini-tts" ? null : form.model;
      if (provider === "meta" && !available.some((entry) => entry.id === model)) {
        throw new Error("Select a supported Meta model.");
      }
      const result = await window.api.createCredential({
        name: form.name.trim(),
        provider,
        model,
        key: form.key,
      });
      if (!result?.ok) throw new Error("Could not save the API configuration.");
      setNotice(provider === "google-gemini-tts"
          ? `Saved “${result.credential.name}”. Test the connection to check Gemini TTS model access.`
          : `Saved “${result.credential.name}”. Test the connection, then verify image support before paid runs.`);
      setAdding(false);
      setForm({ name: "", key: "", model: "" });
      await reload();
      setSelectedId(result.credential.id);
      setDetail(result.credential);
    } catch (err) {
      setError(err?.message ?? "Could not save the API configuration.");
    } finally {
      setBusy("");
    }
  }, [form, models, provider, reload]);

  const runCheck = useCallback(
    async (kind) => {
      if (!selectedId) return;
      setBusy(kind);
      setError("");
      setNotice("");
      setVerificationFailures((current) => current.filter((id) => id !== selectedId));
      try {
        const ttsCredential = selected?.purpose === "tts";
        const action = kind === "connection" && !ttsCredential
          ? window.api.testCredential
          : window.api.verifyCredential;
        const result = await action(selectedId);
        // Surface the main-process diagnosis (already secret-free) instead
        // of a generic message; the buttons below stay enabled for retry.
        // The sanitized detail names the concrete cause (e.g. budget
        // exhaustion vs. empty response) without exposing secrets.
        if (!result?.ok) {
          const detail = typeof result?.detail === "string" && result.detail
            ? ` (detail: ${result.detail})`
            : "";
          throw new Error(`${result?.error ?? "Provider request failed. Check the key, model, and provider compatibility."}${detail}`);
        }
        if (ttsCredential) {
          setNotice("Google API key authenticated and Gemini TTS model metadata is available. Speech generation access was not tested.");
          setDetail(result.credential);
        } else if (kind === "verify") {
          setNotice("Image input verified for the selected key and model.");
          setDetail(result.credential);
        } else {
          setNotice("Connection succeeded. Image support still needs explicit verification.");
        }
        await reload();
      } catch (err) {
        setVerificationFailures((current) => current.includes(selectedId) ? current : [...current, selectedId]);
        setError(err?.message ?? "Provider request failed. Check the key, model, and provider compatibility.");
      } finally {
        setBusy("");
      }
    },
    [reload, selected, selectedId],
  );

  const replaceKey = useCallback(async () => {
    if (!selectedId || !editKey) return;
    setBusy("key");
    setError("");
    setNotice("");
    try {
      const result = await window.api.setCredentialKey(selectedId, editKey);
      if (!result?.ok) throw new Error("Could not replace the API key.");
      setNotice(selected?.purpose === "tts"
          ? "Key replaced. TTS access check was reset — test the connection again."
          : "Key replaced. Image verification was reset — verify again before paid runs.");
      setEditKey("");
      setVerificationFailures((current) => current.filter((id) => id !== selectedId));
      setDetail(result.credential);
      await reload();
    } catch (err) {
      setError(err?.message ?? "Could not replace the API key.");
    } finally {
      setBusy("");
    }
  }, [editKey, reload, selected, selectedId]);

  const changeModel = useCallback(
    async (model) => {
      if (!selectedId || !model || model === detail?.model) return;
      setBusy("model");
      setError("");
      setNotice("");
      try {
        const result = await window.api.setCredentialModel(selectedId, model);
        if (!result?.ok) throw new Error("Could not change the model.");
        setNotice("Model changed. Image verification was reset — verify again before paid runs.");
        setDetail(result.credential);
        await reload();
      } catch (err) {
        setError(err?.message ?? "Could not change the model.");
      } finally {
        setBusy("");
      }
    },
    [detail, reload, selectedId],
  );

  const rename = useCallback(
    async (name) => {
      if (!selectedId || !name.trim() || name.trim() === detail?.name) return;
      setBusy("rename");
      setError("");
      try {
        const result = await window.api.renameCredential(selectedId, name.trim());
        if (!result?.ok) throw new Error("Could not rename the configuration.");
        setDetail(result.credential);
        await reload();
      } catch (err) {
        setError(err?.message ?? "Could not rename the configuration.");
      } finally {
        setBusy("");
      }
    },
    [detail, reload, selectedId],
  );

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
        throw new Error("Could not delete the configuration.");
      }
      setNotice("Configuration deleted.");
      setVerificationFailures((current) => current.filter((id) => id !== selectedId));
      setSelectedId(null);
      setDetail(null);
      setConfirmDelete(false);
      await reload();
    } catch (err) {
      setError(err?.message ?? "Could not delete the configuration.");
    } finally {
      setBusy("");
    }
  }, [reload, selectedId]);

  const addFormId = "api-configuration-create-form";
  const canSave = !busy && form.name.trim() && form.key && (provider !== "meta" || form.model);
  const submitAdd = (event) => {
    event.preventDefault();
    createConfiguration();
  };
  const cancelAction = (
    <Button type="button" size="sm" variant="outline" onClick={() => setAdding(false)} disabled={!!busy}>
      Cancel
    </Button>
  );
  const saveAction = (
    <Button type="submit" size="sm" disabled={!canSave}>
      {busy === "create" ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
      Save configuration
    </Button>
  );
  const addFields = (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <span id="provider-choice-label" className="text-[12px] font-medium text-foreground">Provider</span>
        <div role="group" aria-labelledby="provider-choice-label" className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {[
            { id: "meta", description: "Connect to curated Meta models." },
            { id: "baseten", description: "Run Muse Spark on Baseten." },
            { id: "google-gemini-tts", description: "Configure Google Gemini text-to-speech access." },
          ].map(({ id, description }) => (
            <Button
              key={id}
              type="button"
              variant={provider === id ? "secondary" : "outline"}
              aria-pressed={provider === id}
              onClick={() => setProvider(id)}
              className="h-auto min-h-20 min-w-0 flex-col items-stretch gap-2 whitespace-normal rounded-md px-3 py-3 text-left"
            >
              <span className="flex w-full items-center justify-between gap-2">
                <span className="truncate text-[13px] font-medium">{providerLabel(id)}</span>
                {provider === id ? <Check className="size-4 shrink-0 text-foreground" aria-hidden /> : null}
              </span>
              <span className="text-[11px] font-normal leading-relaxed text-muted-foreground">{description}</span>
            </Button>
          ))}
        </div>
      </div>
      <Field label="Configuration name" hint="A label to recognize this key on this device.">
        <input
          id="api-configuration-name"
          className={`${inputClassName} h-10`}
          value={form.name}
          maxLength={80}
          placeholder="e.g. Meta Personal"
          autoComplete="off"
          onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
        />
      </Field>
      <Field label="API key" hint="Encrypted on this device and never shown again.">
        <input
          id="api-configuration-key"
          type="password"
          autoComplete="new-password"
          className={`${inputClassName} h-10 font-mono`}
          value={form.key}
          placeholder="Paste the provider key"
          onChange={(event) => setForm((current) => ({ ...current, key: event.target.value }))}
        />
      </Field>
      {provider === "meta" ? (
        <Field label="Model" hint="Choose the model used for image analysis.">
          <select
            id="api-configuration-model"
            className={`${inputClassName} h-10`}
            value={form.model}
            onChange={(event) => setForm((current) => ({ ...current, model: event.target.value }))}
          >
            <option value="">Select a model...</option>
            {models.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.id}
              </option>
            ))}
          </select>
        </Field>
      ) : provider === "google-gemini-tts" ? (
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          This configuration is for speech access only. No model selection or speech generation is performed here.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-foreground">Model</span>
          <div className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2.5">
            <code className="truncate font-mono text-[11px] text-foreground">meta-models/muse-spark-open</code>
            <Badge variant="outline" className="shrink-0">Pinned</Badge>
          </div>
          <span className="text-[12px] text-muted-foreground">This model is fixed for Baseten.</span>
        </div>
      )}
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Could not save configuration</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
  const addCard = (
    <Card className="gap-0">
      <CardHeader>
        <CardTitle>Add API configuration</CardTitle>
        <CardDescription>Choose a provider, then save its key securely.</CardDescription>
      </CardHeader>
      <form id={addFormId} onSubmit={submitAdd}>
        <CardContent className="flex flex-col gap-4">{addFields}</CardContent>
        <CardFooter className="justify-end gap-2 border-t border-border pt-4">
          {cancelAction}
          {saveAction}
        </CardFooter>
      </form>
    </Card>
  );

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 pb-8">
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-3">
        {!embedded ? (
          <div className="min-w-0">
            <h1 className="text-[17px] font-semibold tracking-[-0.01em] text-foreground">API Keys</h1>
            <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-muted-foreground">
              Named configurations for Meta Vision, Baseten Vision, and Google Gemini TTS. Keys stay encrypted on this device
              and never reach the interface — only presence and verification status are shown.
            </p>
          </div>
        ) : null}
        <div className="flex shrink-0 items-center gap-2">
          {onBackToEditor ? (
            <Button variant="outline" size="sm" onClick={onBackToEditor}>
              <ArrowLeft data-icon="inline-start" /> Back to editor
            </Button>
          ) : null}
          <Button size="sm" onClick={startAdd} disabled={adding || loading || !!busy}>
            <Plus data-icon="inline-start" /> Add configuration
          </Button>
        </div>
      </div>

      {!secureStorage ? (
        <Alert variant="destructive">
          <AlertTitle>Secure storage unavailable</AlertTitle>
          <AlertDescription>
            This device cannot encrypt credentials, so configurations cannot be saved or read.
            Resolve OS keychain access, then reload this page.
          </AlertDescription>
        </Alert>
      ) : null}

      {migration && !migration.migrated ? (
        <Alert>
          <AlertTitle>Migration notice</AlertTitle>
          <AlertDescription>{migration.notice}</AlertDescription>
        </Alert>
      ) : null}

      {embedded && adding ? addCard : null}
      {!embedded ? (
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
                  <DialogTitle className="text-[15px] tracking-tight">New API configuration</DialogTitle>
                  <DialogDescription className="text-[12px] leading-relaxed">
                    Save a provider key for Vision analysis or Gemini TTS access. You can test it after creation.
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>
            <form id={addFormId} onSubmit={submitAdd} className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{addFields}</div>
              <div className="flex flex-col gap-3 border-t border-border bg-card px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
                <p className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <ShieldCheck className="size-4 shrink-0" aria-hidden />
                  Encrypted on this device
                </p>
                <DialogFooter className="gap-2 sm:flex-row">
                  {cancelAction}
                  {saveAction}
                </DialogFooter>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Saved configurations</CardTitle>
          <CardDescription>
            {credentials.length === 0
              ? "No configurations yet."
              : `${credentials.length} configuration${credentials.length === 1 ? "" : "s"}. Saved keys are never shown.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {loading ? (
            <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <Spinner /> Loading configurations…
            </p>
          ) : credentials.length === 0 ? (
            <div className="flex flex-col items-start gap-2 rounded-sm border border-border bg-background px-3 py-4">
              <p className="text-[13px] font-medium text-foreground">No API configurations</p>
              <p className="max-w-md text-[12px] leading-relaxed text-muted-foreground">
                Add a Meta or Baseten configuration for paid Vision analysis, or Google Gemini TTS
                for speech access. Offline frame extraction remains available without Vision setup.
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {credentials.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => openDetail(entry.id)}
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
                        {providerLabel(entry.provider)} · {credentialTarget(entry)}
                      </span>
                    </span>
                    {statusBadge({ ...entry, verificationFailed: verificationFailures.includes(entry.id) })}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {selected ? (
        <Card>
          <CardHeader>
            <CardTitle>{selected.name}</CardTitle>
            <CardDescription>
              {providerLabel(selected.provider)} · <span className="font-mono">{credentialTarget(selected)}</span>
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              {statusBadge({ ...selected, verificationFailed: verificationFailures.includes(selected.id) })}
              <span className="text-[12px] text-muted-foreground">
                {selected.keyAvailable ? "Credential stored securely" : "Stored key cannot be read"}
                {" · "}verified {formatTimestamp(selected.verification?.verifiedAt)}
              </span>
            </div>
            <Separator />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={!!busy} onClick={() => runCheck("connection")}>
                {busy === "connection" ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <Wifi data-icon="inline-start" />}
                {busy === "connection" && selected.purpose === "tts" ? "Verifying…" : "Test connection"}
              </Button>
              {selected.purpose !== "tts" ? <Button size="sm" variant="outline" disabled={!!busy} onClick={() => runCheck("verify")}>
                <ShieldCheck data-icon="inline-start" /> Verify image support
              </Button> : null}
            </div>
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              {selected.purpose === "tts" ? (
                "Checks Google API authentication and access to Gemini TTS model metadata. It does not generate speech or confirm inference entitlement."
              ) : (
                <>
              Verification sends one minimal image request with this exact key and model and can
              incur provider charges. It is never run automatically and is invalidated whenever
              the key or model changes.
                </>
              )}
            </p>
            <Separator />
            <DetailNameRow name={selected.name} busy={busy} onRename={rename} />
            {selected.purpose === "tts" ? null : <>
            <Field label="Model" hint="Changing the model resets image verification.">
              <select
                className={inputClassName}
                value={selected.model}
                disabled={!!busy || selected.provider === "baseten"}
                onChange={(event) => changeModel(event.target.value)}
              >
                {(selected.provider === "baseten"
                  ? [{ id: "meta-models/muse-spark-open" }]
                  : models.length > 0
                    ? models
                    : [{ id: selected.model }]
                ).map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.id}
                  </option>
                ))}
              </select>
            </Field>
            </>}
            <Field label="Replace API key" hint="Write-only. Replacing the key resets image verification.">
              <div className="flex gap-2">
                <input
                  type="password"
                  autoComplete="new-password"
                  className={`${inputClassName} min-w-0 flex-1`}
                  value={editKey}
                  placeholder="Paste the new key"
                  onChange={(event) => setEditKey(event.target.value)}
                />
                <Button size="sm" variant="outline" disabled={!!busy || !editKey} onClick={replaceKey}>
                  <RefreshCw data-icon="inline-start" /> Replace
                </Button>
              </div>
            </Field>
            <Separator />
            {!confirmDelete ? (
              <div>
                <Button size="sm" variant="outline" disabled={!!busy} onClick={() => setConfirmDelete(true)}>
                  <Trash2 data-icon="inline-start" /> Delete configuration
                </Button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2 rounded-sm border border-border bg-background px-3 py-2.5">
                <p className="mr-auto text-[12px] text-muted-foreground">
                  Delete “{selected.name}”? Projects using it must choose another configuration first.
                </p>
                <Button size="sm" variant="outline" disabled={!!busy} onClick={() => setConfirmDelete(false)}>
                  Keep
                </Button>
                <Button size="sm" variant="destructive" disabled={!!busy} onClick={remove}>
                  <Trash2 data-icon="inline-start" /> Delete
                </Button>
              </div>
            )}
            <Button size="sm" variant="outline" className="self-start" onClick={() => { setSelectedId(null); setDetail(null); setConfirmDelete(false); }}>
              Close details
            </Button>
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
      {error && !adding ? (
        <Alert variant="destructive">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function DetailNameRow({ name, busy, onRename }) {
  const [value, setValue] = useState(name);
  useEffect(() => setValue(name), [name]);
  return (
    <div className="flex flex-col gap-1.5 text-[13px]">
      <span className="font-medium text-foreground">Configuration name</span>
      <div className="flex gap-2">
        <input
          className={`${inputClassName} min-w-0 flex-1`}
          value={value}
          maxLength={80}
          disabled={!!busy}
          onChange={(event) => setValue(event.target.value)}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={!!busy || !value.trim() || value.trim() === name}
          onClick={() => onRename(value)}
        >
          <Pencil data-icon="inline-start" /> Rename
        </Button>
      </div>
    </div>
  );
}
