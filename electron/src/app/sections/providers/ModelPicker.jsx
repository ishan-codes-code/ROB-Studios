import { useCallback, useEffect, useState } from "react";
import { Check, LoaderCircle, Search } from "lucide-react";
import { Button } from "@/components/ui/button.jsx";
import { validateEndpointInput } from "@/lib/config-validation.js";

const inputClassName =
  "h-10 rounded-md border border-input bg-background px-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

/**
 * Model selection for Meta (curated list), Baseten (pinned display),
 * and custom endpoints (best-effort discovery with search plus manual
 * entry). Discovery input is either `{ credentialId }` for a saved
 * record or `{ baseUrl, key }` for one-shot pre-save discovery; the
 * key is used once by the main process and never stored by this call.
 * Calls `onSelect(id)` for every choice; the parent persists it.
 */
export default function ModelPicker({
  provider,
  value,
  onSelect,
  discoveryInput = null,
  curatedModels = [],
  curatedLoading = false,
  disabled = false,
  onError,
}) {
  const [discovered, setDiscovered] = useState([]);
  const [discoveryRan, setDiscoveryRan] = useState(false);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  // A new endpoint/key starts discovery over: stale lists must never
  // offer models from a different configuration.
  const discoveryKey = discoveryInput
    ? (discoveryInput.credentialId ?? `${discoveryInput.baseUrl ?? ""}${discoveryInput.key ? ":key" : ""}`)
    : "";
  useEffect(() => {
    setDiscovered([]);
    setDiscoveryRan(false);
    setSearch("");
    setNotice("");
  }, [discoveryKey, provider]);

  const discover = useCallback(async () => {
    setBusy(true);
    setNotice("");
    onError?.("");
    try {
      if (!discoveryInput) throw new Error("Add the endpoint URL and key first.");
      if (!discoveryInput.credentialId) {
        const urlError = validateEndpointInput(discoveryInput.baseUrl);
        if (urlError) throw new Error(urlError);
        if (!discoveryInput.key) throw new Error("Paste the API key first.");
      }
      const result = await window.api.discoverCustomModels(discoveryInput);
      setDiscoveryRan(true);
      if (!result?.ok) {
        if (result?.code === "discovery_unsupported") {
          setDiscovered([]);
          setNotice("This endpoint does not list models. Enter the model ID manually.");
          return;
        }
        throw new Error(result?.error ?? "Could not list models for this endpoint.");
      }
      setDiscovered(result.models ?? []);
      if ((result.models ?? []).length === 0) {
        setNotice("The endpoint returned no models. Enter the model ID manually.");
      }
    } catch (err) {
      onError?.(err?.message ?? "Could not list models for this endpoint.");
    } finally {
      setBusy(false);
    }
  }, [discoveryInput, onError]);

  if (provider === "baseten") {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium text-foreground">Model</span>
        <div className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2.5">
          <code className="truncate font-mono text-[11px] text-foreground">meta-models/muse-spark-open</code>
          <span className="shrink-0 text-[11px] text-muted-foreground">Pinned</span>
        </div>
        <span className="text-[12px] text-muted-foreground">This model is fixed for Baseten.</span>
      </div>
    );
  }

  if (provider === "meta") {
    const options = value && !curatedModels.some((entry) => entry.id === value)
      ? [...curatedModels, { id: value }]
      : curatedModels;
    return (
      <label className="flex min-w-0 flex-col gap-1.5 text-[13px]">
        <span className="font-medium text-foreground">Model</span>
        <select
          className={inputClassName}
          value={value}
          disabled={disabled || curatedLoading}
          onChange={(event) => onSelect(event.target.value)}
        >
          <option value="">Select a model…</option>
          {options.map((entry) => (
            <option key={entry.id} value={entry.id}>{entry.id}</option>
          ))}
        </select>
        <span className="text-[12px] text-muted-foreground">
          {curatedLoading ? "Loading models…" : "Choose the model used for image analysis."}
        </span>
      </label>
    );
  }

  const query = search.trim().toLowerCase();
  const filtered = query
    ? discovered.filter((entry) => entry.id.toLowerCase().includes(query))
    : discovered;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-[13px]">
          <span className="font-medium text-foreground">Search discovered models</span>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input
              className={`${inputClassName} w-full pl-9`}
              value={search}
              placeholder="Filter models…"
              autoComplete="off"
              disabled={disabled || busy || discovered.length === 0}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        </label>
        <Button size="sm" variant="outline" disabled={disabled || busy} onClick={discover}>
          {busy ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
          {discoveryRan ? "Refresh models" : "Discover models"}
        </Button>
      </div>
      {filtered.length > 0 ? (
        <ul className="flex max-h-44 flex-col gap-1 overflow-y-auto rounded-md border border-border p-1.5">
          {filtered.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                onClick={() => onSelect(entry.id)}
                aria-pressed={value === entry.id}
                disabled={disabled || busy}
                className={`flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-left font-mono text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${
                  value === entry.id ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{entry.id}</span>
                {value === entry.id ? <Check className="size-3.5 shrink-0" aria-hidden /> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <label className="flex min-w-0 flex-col gap-1.5 text-[13px]">
        <span className="font-medium text-foreground">Model ID</span>
        <input
          className={`${inputClassName} font-mono`}
          value={value}
          placeholder="e.g. qwen2-vl-72b-instruct"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled || busy}
          onChange={(event) => onSelect(event.target.value)}
        />
        <span className="text-[12px] text-muted-foreground">
          Manual entry always works. Discovery membership never implies image support.
        </span>
      </label>
      {notice ? (
        <p role="status" className="text-[12px] leading-relaxed text-muted-foreground">{notice}</p>
      ) : null}
    </div>
  );
}
