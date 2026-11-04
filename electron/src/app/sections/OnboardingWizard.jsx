import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowLeft,
  ArrowRight,
  AudioLines,
  Check,
  Clapperboard,
  LoaderCircle,
  Search,
  ShieldCheck,
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
  validateEndpointInput,
  validateKeyInput,
  validateModelInput,
  validateName,
} from "@/lib/config-validation.js";
import {
  clampOnboardingStep,
  modelsStepReady,
  onboardingReadiness,
  providerStepReady,
} from "@/lib/onboarding.js";
import { EASING, MOTION } from "@/lib/tokens.js";

const PROVIDER_OPTIONS = [
  { id: "meta", name: "Meta", blurb: "Curated Muse models over the Meta Model API." },
  { id: "baseten", name: "Baseten", blurb: "Muse Spark Open on Baseten infrastructure." },
  { id: "custom", name: "Custom", blurb: "Any OpenAI-compatible endpoint, explicitly verified for vision." },
];

const STEP_LABELS = ["Welcome", "Provider", "Model", "Ready"];

const inputClassName =
  "h-10 rounded-md border border-input bg-background px-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

function Field({ label, hint, children }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-[13px]">
      <span className="font-medium text-foreground">{label}</span>
      {children}
      {hint ? <span className="text-[12px] text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

function providerName(id) {
  return PROVIDER_OPTIONS.find((entry) => entry.id === id)?.name ?? id;
}

/**
 * First-launch guided setup. Four resumable steps (welcome, provider,
 * model, summary) over the existing vault/settings IPC — no new
 * backend contracts. Progress persists to settings.onboarding on every
 * transition so an interrupted setup resumes where it stopped without
 * duplicating the saved credential. Completion requires a verified
 * vision credential; game metadata lives on each project and TTS stays
 * optional (Voice Providers, later).
 */
export default function OnboardingWizard({ initialSettings, onComplete, onExit }) {
  const settingsRef = useRef(initialSettings);
  const [step, setStep] = useState(() => clampOnboardingStep(initialSettings?.onboarding?.step ?? 0));
  const [furthest, setFurthest] = useState(() => clampOnboardingStep(initialSettings?.onboarding?.step ?? 0));
  const [provider, setProvider] = useState("meta");
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [credential, setCredential] = useState(null);
  const [adopting, setAdopting] = useState(() => Boolean(initialSettings?.onboarding?.credentialId));
  const [secureStorage, setSecureStorage] = useState(true);
  const [models, setModels] = useState([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [discoveryRan, setDiscoveryRan] = useState(false);
  const [discoveryUnsupported, setDiscoveryUnsupported] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [model, setModel] = useState("");
  const [connectState, setConnectState] = useState("idle");
  const [verifyState, setVerifyState] = useState("idle");
  const [busy, setBusy] = useState("");
  const [stepError, setStepError] = useState("");
  const [opError, setOpError] = useState("");
  const [opNotice, setOpNotice] = useState("");
  const [projectPath, setProjectPath] = useState(null);
  const [projectName, setProjectName] = useState("");
  const [createdProjectId, setCreatedProjectId] = useState(null);

  const visionVerified = credential?.verification?.status === "verified";
  const readiness = onboardingReadiness({
    credentialId: credential?.id ?? null,
    visionVerified,
    model: credential?.model ?? null,
  });

  const persist = useCallback(async (nextStep, credentialId) => {
    const current = settingsRef.current ?? {};
    const result = await window.api.saveSettings({
      ...current,
      onboarding: { step: clampOnboardingStep(nextStep), credentialId: credentialId ?? null },
    });
    if (!result?.ok) throw new Error("Could not save setup progress. Check the local data directory and try again.");
    settingsRef.current = result.settings;
  }, []);

  const goTo = useCallback(async (next) => {
    const target = clampOnboardingStep(next);
    setStepError("");
    try {
      await persist(target, credential?.id ?? null);
    } catch (err) {
      setStepError(err?.message ?? "Could not save setup progress.");
      return;
    }
    setFurthest((current) => Math.max(current, target));
    setStep(target);
  }, [credential?.id, persist]);

  // Adopt the in-progress credential when resuming, so revisiting the
  // provider step never creates a duplicate. A record deleted outside
  // the wizard drops the flow back to the provider step honestly.
  useEffect(() => {
    const savedId = initialSettings?.onboarding?.credentialId ?? null;
    if (!savedId) return;
    let alive = true;
    (async () => {
      try {
        const result = await window.api.listCredentials();
        if (!alive) return;
        const found = result?.credentials?.find((entry) => entry.id === savedId) ?? null;
        if (found) {
          setCredential(found);
          setProvider(found.provider);
          setName(found.name);
          setModel(found.model ?? "");
          setBaseUrl(found.baseUrl ?? "");
          if (found.verification?.status === "verified") setVerifyState("verified");
          setSecureStorage(result.secureStorageAvailable !== false);
        } else {
          setStepError("The in-progress setup credential is gone. Enter the provider details again.");
          setStep(1);
          setFurthest(1);
          try {
            await persist(1, null);
          } catch {
            // Progress-save failure surfaces on the next transition.
          }
        }
      } catch {
        if (alive) setStepError("Could not reload the in-progress setup. Check the connection to the local app and retry.");
      } finally {
        if (alive) setAdopting(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [initialSettings, persist]);

  // Curated models load on arrival; custom discovery stays on-demand so
  // merely opening the step never fires a network request.
  useEffect(() => {
    if (step !== 2 || credential || provider === "custom") return;
    let alive = true;
    setModelsLoading(true);
    window.api.providerModels(provider).then((result) => {
      if (!alive) return;
      setModels(result?.models ?? []);
      if (result?.models?.length === 1) {
        setModel((current) => current || result.models[0].id);
      } else if (provider === "meta" && (result?.models ?? []).length > 0) {
        setModel((current) => current || result.models[0].id);
      }
    }).catch(() => {
      if (alive) setModels([]);
    }).finally(() => {
      if (alive) setModelsLoading(false);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, credential, provider]);

  const saveConfiguration = useCallback(async () => {
    setBusy("create");
    setOpError("");
    setOpNotice("");
    try {
      const nameError = validateName(name, "Configuration name");
      if (nameError) throw new Error(nameError);
      const keyError = validateKeyInput(key);
      if (keyError) throw new Error(keyError);
      if (provider === "custom") {
        const urlError = validateEndpointInput(baseUrl);
        if (urlError) throw new Error(urlError);
      }
      const modelError = validateModelInput(model);
      if (modelError) throw new Error(provider === "custom" ? "Select a discovered model or enter one manually." : modelError);
      const result = await window.api.createCredential({
        name: name.trim(),
        provider,
        model: model.trim(),
        key,
        ...(provider === "custom" ? { baseUrl: baseUrl.trim() } : {}),
      });
      if (!result?.ok) throw new Error("Could not save the configuration. The name may already be in use.");
      setCredential(result.credential);
      setKey("");
      setOpNotice("Saved securely on this device. Test the connection, then verify image support.");
      await persist(2, result.credential.id);
    } catch (err) {
      setOpError(err?.message ?? "Could not save the configuration.");
    } finally {
      setBusy("");
    }
  }, [baseUrl, key, model, name, persist, provider]);

  const discover = useCallback(async () => {
    setBusy("discover");
    setOpError("");
    setOpNotice("");
    try {
      const urlError = provider === "custom" && !credential ? validateEndpointInput(baseUrl) : null;
      if (urlError) throw new Error(urlError);
      // Pre-save discovery reuses the typed key one-shot (never stored
      // by this call); post-save discovery resolves the vault record.
      const input = credential ? { credentialId: credential.id } : { baseUrl: baseUrl.trim(), key };
      const result = await window.api.discoverCustomModels(input);
      setDiscoveryRan(true);
      if (!result?.ok) {
        if (result?.code === "discovery_unsupported") {
          setDiscoveryUnsupported(true);
          setModels([]);
          setOpNotice("This endpoint does not list models. Enter the model ID manually below.");
          return;
        }
        throw new Error(result?.error ?? "Could not list models for this endpoint.");
      }
      setModels(result.models ?? []);
      setDiscoveryUnsupported(false);
      if ((result.models ?? []).length === 0) {
        setOpNotice("The endpoint returned no models. Enter the model ID manually below.");
      }
    } catch (err) {
      setOpError(err?.message ?? "Could not list models for this endpoint.");
    } finally {
      setBusy("");
    }
  }, [baseUrl, credential, key, provider]);

  const testConnection = useCallback(async () => {
    if (!credential) return;
    setBusy("connection");
    setOpError("");
    setOpNotice("");
    try {
      const result = await window.api.testCredential(credential.id);
      if (!result?.ok) {
        const detail = typeof result?.detail === "string" && result.detail ? ` (detail: ${result.detail})` : "";
        throw new Error(`${result?.error ?? "Connection failed."}${detail}`);
      }
      setConnectState("connected");
      setOpNotice("Connection succeeded. Image support still needs explicit verification.");
    } catch (err) {
      setConnectState("error");
      setOpError(err?.message ?? "Connection failed.");
    } finally {
      setBusy("");
    }
  }, [credential]);

  const verifyImage = useCallback(async () => {
    if (!credential) return;
    setBusy("verify");
    setOpError("");
    setOpNotice("");
    try {
      const result = await window.api.verifyCredential(credential.id);
      if (!result?.ok) {
        const detail = typeof result?.detail === "string" && result.detail ? ` (detail: ${result.detail})` : "";
        throw new Error(`${result?.error ?? "Image verification failed."}${detail}`);
      }
      setCredential(result.credential);
      setVerifyState("verified");
      setOpNotice("Image input verified for this exact key and model.");
    } catch (err) {
      setVerifyState("error");
      setOpError(err?.message ?? "Image verification failed.");
    } finally {
      setBusy("");
    }
  }, [credential]);

  const changeModel = useCallback(async (next) => {
    setModel(next);
    if (!credential || next === credential.model) return;
    setBusy("model");
    setOpError("");
    try {
      const result = await window.api.setCredentialModel(credential.id, next);
      if (!result?.ok) throw new Error("Could not change the model.");
      setCredential(result.credential);
      setConnectState("idle");
      setVerifyState("idle");
      setOpNotice("Model changed. Verification was reset — test and verify again.");
    } catch (err) {
      setOpError(err?.message ?? "Could not change the model.");
    } finally {
      setBusy("");
    }
  }, [credential]);

  const replaceKey = useCallback(async () => {
    if (!credential || !key) return;
    setBusy("key");
    setOpError("");
    setOpNotice("");
    try {
      const keyError = validateKeyInput(key);
      if (keyError) throw new Error(keyError);
      const result = await window.api.setCredentialKey(credential.id, key);
      if (!result?.ok) throw new Error("Could not replace the key.");
      setCredential(result.credential);
      setKey("");
      setConnectState("idle");
      setVerifyState("idle");
      setOpNotice("Key replaced. Verification was reset — test and verify again on the next step.");
    } catch (err) {
      setOpError(err?.message ?? "Could not replace the key.");
    } finally {
      setBusy("");
    }
  }, [credential, key]);

  const restartSetup = useCallback(async () => {
    if (!credential) return;
    setBusy("restart");
    setOpError("");
    try {
      await window.api.removeCredential(credential.id).catch(() => null);
      setCredential(null);
      setName("");
      setKey("");
      setBaseUrl("");
      setModel("");
      setModels([]);
      setDiscoveryRan(false);
      setDiscoveryUnsupported(false);
      setConnectState("idle");
      setVerifyState("idle");
      await persist(1, null);
      setStep(1);
    } catch (err) {
      setOpError(err?.message ?? "Could not restart setup.");
    } finally {
      setBusy("");
    }
  }, [credential, persist]);

  const pickVideo = useCallback(async () => {
    setBusy("video");
    setStepError("");
    try {
      const result = await window.api.selectVideo();
      if (!result || result.cancelled) return;
      if (!result.ok || !result.path) throw new Error(result?.error ?? "Could not select a video.");
      setProjectPath(result.path);
      const base = result.path.split(/[/\\]/).pop() ?? "Match";
      setProjectName((current) => current || base.replace(/\.[^.]+$/, ""));
    } catch (err) {
      setStepError(err?.message ?? "Could not select a video.");
    } finally {
      setBusy("");
    }
  }, []);

  const createFirstProject = useCallback(async () => {
    if (!projectPath || !projectName.trim()) return;
    setBusy("project");
    setStepError("");
    try {
      const result = await window.api.createProject(projectName.trim(), projectPath);
      if (!result?.ok || !result.project) throw new Error(result?.error ?? "Could not create the project.");
      await window.api.setProjectConfig(result.project.id, {
        credentialId: credential.id,
      }).catch(() => null);
      setCreatedProjectId(result.project.id);
    } catch (err) {
      setStepError(err?.message ?? "Could not create the project.");
    } finally {
      setBusy("");
    }
  }, [credential, projectName, projectPath]);

  const complete = useCallback(async (openProject) => {
    setBusy("complete");
    setStepError("");
    try {
      const current = settingsRef.current ?? {};
      const result = await window.api.saveSettings({
        ...current,
        onboardingCompleted: true,
        onboarding: { step: 3, credentialId: credential?.id ?? null },
      });
      if (!result?.ok) throw new Error("Could not complete setup.");
      onComplete?.({ projectId: openProject ? createdProjectId : null });
    } catch (err) {
      setStepError(err?.message ?? "Could not complete setup.");
    } finally {
      setBusy("");
    }
  }, [createdProjectId, credential?.id, onComplete]);

  const filteredModels = models.filter((entry) => entry.id.toLowerCase().includes(modelSearch.trim().toLowerCase()));

  const providerFormValid = provider !== "custom"
    ? validateName(name, "Configuration name") === null && validateKeyInput(key) === null
    : validateName(name, "Configuration name") === null && validateKeyInput(key) === null
      && validateEndpointInput(baseUrl) === null;

  const renderStep = () => {
    if (step === 0) {
      return (
        <div className="flex flex-col gap-4">
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            Commentary Studio turns match recordings into AI broadcast commentary. Setup takes
            about two minutes: connect a vision provider, verify it can see images, then
            create your first project. Voice narration stays optional.
          </p>
          <ul className="flex flex-col gap-2.5">
            {[
              ["Connect a provider", "Meta, Baseten, or your own OpenAI-compatible endpoint."],
              ["Verify vision", "One explicit image check — support is proven, never assumed."],
              ["Create a project", "Pick a match video; game details live on the project."],
            ].map(([title, hint]) => (
              <li key={title} className="flex items-start gap-2.5">
                <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0">
                  <span className="block text-[13px] font-medium text-foreground">{title}</span>
                  <span className="block text-[12px] leading-relaxed text-muted-foreground">{hint}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            Keys are encrypted with the OS keychain and never leave this device except in the
            provider requests you trigger.
          </p>
        </div>
      );
    }
    if (step === 1) {
      if (adopting) {
        return (
          <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Spinner /> Reloading your in-progress setup…
          </p>
        );
      }
      if (credential) {
        return (
          <div className="flex flex-col gap-4">
            <div className="flex min-w-0 items-center gap-3 rounded-md border border-border bg-muted/40 px-3 py-2.5">
              <ShieldCheck className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium text-foreground">{credential.name}</span>
                <span className="block truncate font-mono text-[11px] text-muted-foreground">
                  {providerName(credential.provider)} · {credential.model}
                  {credential.baseUrl ? ` · ${credential.baseUrl}` : ""}
                </span>
              </span>
              <Badge variant={visionVerified ? "secondary" : "outline"}>
                {visionVerified ? "Vision verified" : "Saved"}
              </Badge>
            </div>
            <Field label="Replace API key" hint="Write-only. Replacing the key resets verification.">
              <div className="flex gap-2">
                <input
                  type="password"
                  autoComplete="new-password"
                  className={`${inputClassName} min-w-0 flex-1 font-mono`}
                  value={key}
                  placeholder="Paste the new key"
                  disabled={!!busy}
                  onChange={(event) => setKey(event.target.value)}
                />
                <Button size="sm" variant="outline" disabled={!!busy || !key} onClick={replaceKey}>
                  {busy === "key" ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
                  Replace
                </Button>
              </div>
            </Field>
            <div>
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={restartSetup}>
                Discard and restart setup
              </Button>
            </div>
            {opNotice ? (
              <p role="status" className="flex items-start gap-2 text-[12px] text-muted-foreground">
                <Check className="mt-0.5 size-4 shrink-0" /> {opNotice}
              </p>
            ) : null}
            {opError ? (
              <Alert variant="destructive">
                <AlertTitle>Could not update</AlertTitle>
                <AlertDescription>{opError}</AlertDescription>
              </Alert>
            ) : null}
          </div>
        );
      }
      return (
        <div className="flex flex-col gap-4">
          {!secureStorage ? (
            <Alert variant="destructive">
              <AlertTitle>Secure storage unavailable</AlertTitle>
              <AlertDescription>
                This device cannot encrypt credentials, so setup cannot continue. Resolve OS
                keychain access, then relaunch the app.
              </AlertDescription>
            </Alert>
          ) : null}
          <div className="flex flex-col gap-2">
            <span id="onboarding-provider-label" className="text-[12px] font-medium text-foreground">Provider</span>
            <div role="group" aria-labelledby="onboarding-provider-label" className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {PROVIDER_OPTIONS.map((option) => (
                <Button
                  key={option.id}
                  type="button"
                  variant={provider === option.id ? "secondary" : "outline"}
                  aria-pressed={provider === option.id}
                  disabled={!!busy}
                  onClick={() => {
                    setProvider(option.id);
                    setModels([]);
                    setModel(option.id === "baseten" ? "meta-models/muse-spark-open" : "");
                    setDiscoveryRan(false);
                    setDiscoveryUnsupported(false);
                  }}
                  className="h-auto min-h-20 min-w-0 flex-col items-stretch gap-2 whitespace-normal rounded-md px-3 py-3 text-left"
                >
                  <span className="flex w-full items-center justify-between gap-2">
                    <span className="truncate text-[13px] font-medium">{option.name}</span>
                    {provider === option.id ? <Check className="size-4 shrink-0" aria-hidden /> : null}
                  </span>
                  <span className="text-[11px] font-normal leading-relaxed text-muted-foreground">{option.blurb}</span>
                </Button>
              ))}
            </div>
          </div>
          <Field label="Configuration name" hint="A label to recognize this key on this device.">
            <input
              className={inputClassName}
              value={name}
              maxLength={80}
              placeholder="e.g. Meta Personal"
              autoComplete="off"
              disabled={!!busy}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          {provider === "custom" ? (
            <Field label="API base URL" hint="Public HTTPS endpoint. Local and private networks are blocked.">
              <input
                className={`${inputClassName} font-mono`}
                value={baseUrl}
                placeholder="https://llm.example.com/v1"
                autoComplete="off"
                spellCheck={false}
                disabled={!!busy}
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            </Field>
          ) : null}
          <Field label="API key" hint="Encrypted on this device and never shown again.">
            <input
              type="password"
              autoComplete="new-password"
              className={`${inputClassName} font-mono`}
              value={key}
              placeholder="Paste the provider key"
              disabled={!!busy}
              onChange={(event) => setKey(event.target.value)}
            />
          </Field>
        </div>
      );
    }
    if (step === 2) {
      return (
        <div className="flex flex-col gap-4">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Badge variant={visionVerified ? "secondary" : connectState === "connected" ? "secondary" : "outline"}>
              {visionVerified ? "Vision verified" : connectState === "connected" ? "Connected" : credential ? "Saved" : "Not saved yet"}
            </Badge>
            <span className="font-mono text-[11px] text-muted-foreground">
              {providerName(provider)}{model ? ` · ${model}` : ""}
              {provider === "custom" && baseUrl ? ` · ${baseUrl}` : ""}
            </span>
          </div>
          {provider === "custom" ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-end gap-2">
                <div className="min-w-0 flex-1">
                  <Field label="Search discovered models" hint={discoveryRan ? `${filteredModels.length} shown` : "Discovery is optional — manual entry always works."}>
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                      <input
                        className={`${inputClassName} w-full pl-9`}
                        value={modelSearch}
                        placeholder="Filter models…"
                        autoComplete="off"
                        disabled={!!busy || models.length === 0}
                        onChange={(event) => setModelSearch(event.target.value)}
                      />
                    </div>
                  </Field>
                </div>
                <Button size="sm" variant="outline" disabled={!!busy} onClick={discover}>
                  {busy === "discover" ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
                  {discoveryRan ? "Refresh models" : "Discover models"}
                </Button>
              </div>
              {modelsLoading ? (
                <p className="flex items-center gap-2 text-[12px] text-muted-foreground">
                  <Spinner /> Contacting the endpoint…
                </p>
              ) : null}
              {filteredModels.length > 0 ? (
                <ul className="flex max-h-44 flex-col gap-1 overflow-y-auto rounded-md border border-border p-1.5">
                  {filteredModels.map((entry) => (
                    <li key={entry.id}>
                      <button
                        type="button"
                        onClick={() => changeModel(entry.id)}
                        aria-pressed={model === entry.id}
                        disabled={!!busy}
                        className={`flex w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1.5 text-left font-mono text-[12px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${
                          model === entry.id ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground"
                        }`}
                      >
                        <span className="min-w-0 flex-1 truncate">{entry.id}</span>
                        {model === entry.id ? <Check className="size-3.5 shrink-0" aria-hidden /> : null}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <Field label="Model ID" hint="Manual entry. Discovery membership never implies image support — verification below proves it.">
                <input
                  className={`${inputClassName} font-mono`}
                  value={model}
                  placeholder="e.g. qwen2-vl-72b-instruct"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={!!busy}
                  onChange={(event) => changeModel(event.target.value)}
                />
              </Field>
            </div>
          ) : (
            <Field label="Model" hint="Support is proven by verification below, never by the model name.">
              <select
                className={inputClassName}
                value={model}
                disabled={!!busy || modelsLoading}
                onChange={(event) => changeModel(event.target.value)}
              >
                <option value="">Select a model…</option>
                {(models.length > 0 ? models : [{ id: model }].filter((entry) => entry.id)).map((entry) => (
                  <option key={entry.id} value={entry.id}>{entry.id}</option>
                ))}
              </select>
            </Field>
          )}
          {!credential ? (
            <div>
              <Button size="sm" disabled={!!busy || !providerFormValid || !model.trim()} onClick={saveConfiguration}>
                {busy === "create" ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
                Save configuration
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <Separator />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={!!busy} onClick={testConnection}>
                  {busy === "connection" ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <Wifi data-icon="inline-start" />}
                  {connectState === "connected" ? "Test again" : "Test connection"}
                </Button>
                <Button size="sm" variant="outline" disabled={!!busy} onClick={verifyImage}>
                  {busy === "verify" ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <ShieldCheck data-icon="inline-start" />}
                  {visionVerified ? "Verify again" : "Verify image support"}
                </Button>
              </div>
              <p className="text-[12px] leading-relaxed text-muted-foreground">
                Verification sends one minimal image request with this exact key and model and can
                incur provider charges. It never runs automatically.
              </p>
            </div>
          )}
          {opNotice ? (
            <p role="status" className="flex items-start gap-2 text-[12px] text-muted-foreground">
              <Check className="mt-0.5 size-4 shrink-0" /> {opNotice}
            </p>
          ) : null}
          {opError ? (
            <Alert variant="destructive">
              <AlertTitle>Something went wrong</AlertTitle>
              <AlertDescription>{opError}</AlertDescription>
            </Alert>
          ) : null}
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-4">
        <dl className="flex flex-col gap-2.5 rounded-md border border-border bg-muted/40 px-3 py-3">
          {[
            ["AI provider", `${providerName(credential?.provider)} · ${credential?.model ?? "—"}`],
            ["Vision", visionVerified ? "Verified for this key and model" : "Not verified"],
          ].map(([term, value]) => (
            <div key={term} className="flex min-w-0 items-baseline justify-between gap-3">
              <dt className="shrink-0 text-[12px] text-muted-foreground">{term}</dt>
              <dd className="min-w-0 truncate text-right text-[12px] font-medium text-foreground" title={value}>{value}</dd>
            </div>
          ))}
        </dl>
        {!readiness.ready ? (
          <Alert variant="destructive">
            <AlertTitle>Setup is incomplete</AlertTitle>
            <AlertDescription>Still needed: {readiness.missing.join(" · ")}. Go back to finish.</AlertDescription>
          </Alert>
        ) : null}
        <Separator />
        <div className="flex flex-col gap-2">
          <h3 className="text-[13px] font-medium text-foreground">First project <span className="font-normal text-muted-foreground">(optional)</span></h3>
          {!createdProjectId ? (
            projectPath ? (
              <div className="flex flex-col gap-2">
                <p className="truncate font-mono text-[11px] text-muted-foreground">{projectPath}</p>
                <div className="flex gap-2">
                  <input
                    className={`${inputClassName} min-w-0 flex-1`}
                    value={projectName}
                    maxLength={100}
                    placeholder="Project name"
                    disabled={!!busy}
                    onChange={(event) => setProjectName(event.target.value)}
                  />
                  <Button size="sm" disabled={!!busy || !projectName.trim()} onClick={createFirstProject}>
                    {busy === "project" ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
                    Create
                  </Button>
                </div>
              </div>
            ) : (
              <div>
                <Button size="sm" variant="outline" disabled={!!busy} onClick={pickVideo}>
                  <Clapperboard data-icon="inline-start" />
                  Choose a match video…
                </Button>
              </div>
            )
          ) : (
            <p role="status" className="flex items-start gap-2 text-[12px] text-muted-foreground">
              <Check className="mt-0.5 size-4 shrink-0" /> Project created with this setup applied.
            </p>
          )}
        </div>
      </div>
    );
  };

  const canContinue = step === 0
    || (step === 1 && (credential ? true : providerFormValid) && secureStorage)
    || (step === 2 && modelsStepReady({ model: credential?.model ?? null, visionVerified }))
    || step === 3;

  const continueLabel = step === 0 ? "Get started" : step === 3 ? null : "Continue";

  return (
    <div className="flex h-full min-h-0 flex-col items-center overflow-y-auto bg-background px-4 py-8">
      <div className="flex w-full max-w-xl flex-col gap-5">
        <div className="flex items-center gap-2.5">
          <span className="flex size-7 items-center justify-center rounded-sm bg-foreground text-background">
            <AudioLines className="size-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">Commentary Studio</p>
            <p className="text-[11px] text-muted-foreground">Guided setup · progress saves automatically</p>
          </div>
        </div>
        <ol className="flex items-center gap-1.5" aria-label="Setup progress">
          {STEP_LABELS.map((label, index) => {
            const reached = index <= furthest;
            const done = index < step || (index <= furthest && index < furthest);
            const current = index === step;
            return (
              <li key={label} className="min-w-0 flex-1">
                <button
                  type="button"
                  disabled={!reached || !!busy || index === step || adopting}
                  onClick={() => goTo(index)}
                  aria-current={current ? "step" : undefined}
                  className="flex w-full min-w-0 flex-col gap-1.5 rounded-sm px-1 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
                >
                  <span
                    className={`h-1 w-full rounded-full ${current ? "bg-foreground" : done ? "bg-foreground/60" : "bg-border"}`}
                    aria-hidden
                  />
                  <span className={`truncate text-[11px] ${current ? "font-medium text-foreground" : "text-muted-foreground"}`}>
                    {label}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        <Card>
          <CardHeader>
            <CardTitle>
              {step === 0 ? "Prepare your broadcast" : step === 1 ? "Connect an AI provider" : step === 2 ? "Choose and verify a model" : "Ready to broadcast"}
            </CardTitle>
            <CardDescription>
              {step === 0 ? "Two quick decisions before your first project."
                : step === 1 ? "Credentials stay encrypted on this device."
                : step === 2 ? "Image support is proven with a live check, never assumed."
                : "Review the setup, optionally create a project, then start."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={step}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: MOTION.standard, ease: EASING.entrance }}
              >
                {renderStep()}
              </motion.div>
            </AnimatePresence>
            {stepError ? (
              <Alert variant="destructive" className="mt-4">
                <AlertTitle>Something went wrong</AlertTitle>
                <AlertDescription>{stepError}</AlertDescription>
              </Alert>
            ) : null}
          </CardContent>
          <CardFooter className="justify-between gap-2 border-t border-border pt-4">
            <div className="flex gap-2">
              {step > 0 ? (
                <Button size="sm" variant="outline" disabled={!!busy || adopting} onClick={() => goTo(step - 1)}>
                  <ArrowLeft data-icon="inline-start" /> Back
                </Button>
              ) : (
                <Button size="sm" variant="ghost" onClick={onExit}>
                  Finish later
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              {step > 0 && step < 3 ? (
                <Button size="sm" variant="ghost" onClick={onExit}>
                  Finish later
                </Button>
              ) : null}
              {continueLabel ? (
                <Button size="sm" disabled={!!busy || adopting || !canContinue} onClick={() => goTo(step + 1)}>
                  {continueLabel} <ArrowRight data-icon="inline-end" />
                </Button>
              ) : (
                <div className="flex gap-2">
                  {createdProjectId ? (
                    <Button size="sm" disabled={!!busy || !readiness.ready} onClick={() => complete(true)}>
                      {busy === "complete" ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
                      Complete & open project
                    </Button>
                  ) : null}
                  <Button size="sm" variant={createdProjectId ? "outline" : "default"} disabled={!!busy || !readiness.ready} onClick={() => complete(false)}>
                    {busy === "complete" && !createdProjectId ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
                    Complete setup
                  </Button>
                </div>
              )}
            </div>
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
