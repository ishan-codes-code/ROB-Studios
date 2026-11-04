import { useEffect, useState } from "react";
import { Check, HardDrive, LoaderCircle, Lock } from "lucide-react";
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
import { setupTogglePayload } from "@/lib/onboarding.js";

/**
 * Application-wide preferences. Only real, supported settings live here:
 * secure-storage status, setup state, and the local-first data note.
 * Provider credentials, game profiles, and commentary presets have their
 * own management pages.
 */
export default function PreferencesSection() {
  const [settings, setSettings] = useState(null);
  const [credentialAvailable, setCredentialAvailable] = useState(false);
  const [savedCount, setSavedCount] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [loaded, vault] = await Promise.all([
          window.api.loadSettings(),
          window.api.listCredentials().catch(() => null),
        ]);
        if (!alive) return;
        if (!loaded?.ok) throw new Error("Could not load preferences.");
        setSettings(loaded.settings);
        setCredentialAvailable(loaded.credentialAvailable === true);
        if (vault?.ok) setSavedCount(vault.credentials?.length ?? null);
      } catch (err) {
        if (alive) setError(err?.message ?? "Could not load preferences.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const toggleSetup = async () => {
    if (!settings) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      // Replaying starts the wizard from the welcome step and clears
      // any Finish-later dismissal so it actually shows; the saved
      // vault credential (if any) is adopted, never duplicated.
      const result = await window.api.saveSettings({
        ...settings,
        ...setupTogglePayload(settings),
      });
      if (!result?.ok) throw new Error("Could not save preferences.");
      setSettings(result.settings);
      setNotice(
        result.settings.onboardingCompleted
          ? "Setup marked complete."
          : "Welcome flow will show on the next launch.",
      );
    } catch (err) {
      setError(err?.message ?? "Could not save preferences.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 pb-8">
      <div className="min-w-0">
        <h1 className="text-[17px] font-semibold tracking-[-0.01em] text-foreground">General</h1>
        <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-muted-foreground">
          Application preferences. Providers live under AI Providers, styles under Game Profiles and Commentary Presets.
        </p>
      </div>

      {loading ? (
        <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Spinner /> Loading preferences…
        </p>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Secure storage</CardTitle>
              <CardDescription>OS-backed encryption for saved API keys.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 text-[13px] text-foreground">
                  <Lock className="size-4 text-muted-foreground" aria-hidden />
                  OS keychain
                </span>
                <Badge variant={credentialAvailable ? "secondary" : "destructive"}>
                  {credentialAvailable ? "Available" : "Unavailable"}
                </Badge>
              </div>
              <p className="text-[12px] leading-relaxed text-muted-foreground">
                {credentialAvailable
                  ? `Credentials are encrypted at rest. ${savedCount ?? "No"} API configuration${savedCount === 1 ? " is" : "s are"} saved.`
                  : "Secure storage is unavailable on this device: configurations cannot be saved or read until OS keychain access is restored. There is no plaintext fallback."}
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Setup state</CardTitle>
              <CardDescription>Whether the first-run setup flow is considered complete.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-2">
              <span className="mr-auto text-[13px] text-muted-foreground">
                {settings?.onboardingCompleted
                  ? "Setup complete."
                  : settings?.onboarding?.dismissed === true
                    ? "Setup deferred (Finish later). Replay to configure."
                    : "Welcome flow pending."}
              </span>
              <Button size="sm" variant="outline" disabled={busy || !settings} onClick={toggleSetup}>
                {busy ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : null}
                {settings?.onboardingCompleted || settings?.onboarding?.dismissed === true ? "Replay welcome flow" : "Mark setup complete"}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Local-first data</CardTitle>
              <CardDescription>Where this application keeps your work.</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="flex items-start gap-2 text-[12px] leading-relaxed text-muted-foreground">
                <HardDrive className="mt-0.5 size-4 shrink-0" aria-hidden />
                Projects, API configurations, game profiles, and presets stay in this
                application&apos;s local data directory. There is no cloud backend, no
                account, and no synchronization — only the explicit provider requests
                you trigger leave this machine.
              </p>
            </CardContent>
          </Card>
        </>
      )}

      <Separator />
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
