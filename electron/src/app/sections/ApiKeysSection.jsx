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
  CardHeader,
  CardTitle,
} from "@/components/ui/card.jsx";
import { Separator } from "@/components/ui/separator.jsx";
import { Spinner } from "@/components/ui/spinner.jsx";

const PROVIDER_META = {
  meta: { displayName: "Meta Model API" },
  baseten: { displayName: "Baseten" },
};

function providerLabel(id) {
  return PROVIDER_META[id]?.displayName ?? id;
}

function statusBadge(credential) {
  if (!credential.keyAvailable) {
    return <Badge variant="destructive">Key unreadable</Badge>;
  }
  if (credential.verification?.status === "verified") {
    return <Badge variant="secondary">Vision verified</Badge>;
  }
  return <Badge variant="outline">Unverified</Badge>;
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

export default function ApiKeysSection({ onBackToEditor }) {
  const [credentials, setCredentials] = useState([]);
  const [secureStorage, setSecureStorage] = useState(true);
  const [migration, setMigration] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
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
      const available = catalog?.models ?? (provider === "meta" ? models : [{ id: "meta-models/muse-spark-open-1026" }]);
      const model = provider === "baseten" ? "meta-models/muse-spark-open-1026" : form.model;
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
      setNotice(`Saved “${result.credential.name}”. Test the connection, then verify image support before paid runs.`);
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
      try {
        const action = kind === "connection" ? window.api.testCredential : window.api.verifyCredential;
        const result = await action(selectedId);
        if (!result?.ok) throw new Error("Provider request failed. Check the key, model, and provider compatibility.");
        if (kind === "verify") {
          setNotice("Image input verified for the selected key and model.");
          setDetail(result.credential);
        } else {
          setNotice("Connection succeeded. Image support still needs explicit verification.");
        }
        await reload();
      } catch (err) {
        setError(err?.message ?? "Provider request failed. Check the key, model, and provider compatibility.");
      } finally {
        setBusy("");
      }
    },
    [reload, selectedId],
  );

  const replaceKey = useCallback(async () => {
    if (!selectedId || !editKey) return;
    setBusy("key");
    setError("");
    setNotice("");
    try {
      const result = await window.api.setCredentialKey(selectedId, editKey);
      if (!result?.ok) throw new Error("Could not replace the API key.");
      setNotice("Key replaced. Image verification was reset — verify again before paid runs.");
      setEditKey("");
      setDetail(result.credential);
      await reload();
    } catch (err) {
      setError(err?.message ?? "Could not replace the API key.");
    } finally {
      setBusy("");
    }
  }, [editKey, reload, selectedId]);

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

  const selected = detail ?? credentials.find((entry) => entry.id === selectedId) ?? null;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 pb-8">
      <div className="flex min-w-0 flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[17px] font-semibold tracking-[-0.01em] text-foreground">API Keys</h1>
          <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-muted-foreground">
            Named provider configurations for Meta and Baseten. Keys stay encrypted on this device
            and never reach the interface — only presence and verification status are shown.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {onBackToEditor ? (
            <Button variant="outline" size="sm" onClick={onBackToEditor}>
              <ArrowLeft data-icon="inline-start" /> Back to editor
            </Button>
          ) : null}
          <Button size="sm" onClick={startAdd} disabled={adding || loading}>
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

      {adding ? (
        <Card>
          <CardHeader>
            <CardTitle>Add API configuration</CardTitle>
            <CardDescription>
              Pick a provider, name the configuration, paste its key, and choose a supported model.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5" role="group" aria-label="Provider">
              <span className="text-[13px] font-medium text-foreground">Provider</span>
              <div className="flex flex-wrap gap-2">
                {["meta", "baseten"].map((id) => (
                  <Button
                    key={id}
                    type="button"
                    size="sm"
                    variant={provider === id ? "default" : "outline"}
                    aria-pressed={provider === id}
                    onClick={() => setProvider(id)}
                  >
                    {providerLabel(id)}
                  </Button>
                ))}
              </div>
            </div>
            <Field label="Configuration name" hint="Free-form label, e.g. “Meta Personal”.">
              <input
                className={inputClassName}
                value={form.name}
                maxLength={80}
                placeholder="Meta Personal"
                onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              />
            </Field>
            <Field label="API key" hint="Write-only. Stored encrypted; never displayed again.">
              <input
                type="password"
                autoComplete="new-password"
                className={inputClassName}
                value={form.key}
                placeholder="Paste the provider key"
                onChange={(event) => setForm((current) => ({ ...current, key: event.target.value }))}
              />
            </Field>
            {provider === "meta" ? (
              <Field label="Model" hint="Only curated vision-capable Meta models are offered.">
                <select
                  className={inputClassName}
                  value={form.model}
                  onChange={(event) => setForm((current) => ({ ...current, model: event.target.value }))}
                >
                  <option value="">Select a model…</option>
                  {models.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.id}
                    </option>
                  ))}
                </select>
              </Field>
            ) : (
              <p className="text-[12px] leading-relaxed text-muted-foreground">
                Model is fixed to <span className="font-mono">meta-models/muse-spark-open-1026</span> for Baseten.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={!!busy || !form.name.trim() || !form.key || (provider === "meta" && !form.model)}
                onClick={createConfiguration}
              >
                {busy === "create" ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
                Save securely
              </Button>
              <Button size="sm" variant="outline" onClick={() => setAdding(false)} disabled={!!busy}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
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
                Add a Meta or Baseten configuration to enable paid vision analysis. Until then,
                offline frame extraction remains available.
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
                        {providerLabel(entry.provider)} · {entry.model}
                      </span>
                    </span>
                    {statusBadge(entry)}
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
              {providerLabel(selected.provider)} · <span className="font-mono">{selected.model}</span>
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              {statusBadge(selected)}
              <span className="text-[12px] text-muted-foreground">
                {selected.keyAvailable ? "Credential stored securely" : "Stored key cannot be read"}
                {" · "}verified {formatTimestamp(selected.verification?.verifiedAt)}
              </span>
            </div>
            <Separator />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={!!busy} onClick={() => runCheck("connection")}>
                <Wifi data-icon="inline-start" /> Test connection
              </Button>
              <Button size="sm" variant="outline" disabled={!!busy} onClick={() => runCheck("verify")}>
                <ShieldCheck data-icon="inline-start" /> Verify image support
              </Button>
            </div>
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              Verification sends one minimal image request with this exact key and model and can
              incur provider charges. It is never run automatically and is invalidated whenever
              the key or model changes.
            </p>
            <Separator />
            <DetailNameRow name={selected.name} busy={busy} onRename={rename} />
            <Field label="Model" hint="Changing the model resets image verification.">
              <select
                className={inputClassName}
                value={selected.model}
                disabled={!!busy || selected.provider === "baseten"}
                onChange={(event) => changeModel(event.target.value)}
              >
                {(selected.provider === "baseten"
                  ? [{ id: "meta-models/muse-spark-open-1026" }]
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
      {error ? (
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
