import { useCallback, useEffect, useState } from "react";

/**
 * Shared credential-vault reads for configuration surfaces (providers
 * list, onboarding wizard, settings overview). Single fetch boundary so
 * every surface reports the same list, secure-storage state, and
 * migration notice without duplicating IPC handling.
 */
export default function useCredentials() {
  const [credentials, setCredentials] = useState([]);
  const [secureStorage, setSecureStorage] = useState(true);
  const [devBypass, setDevBypass] = useState({ supported: false, enabled: false });
  const [migration, setMigration] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [result, bypass] = await Promise.all([
        window.api.listCredentials(),
        window.api.getDevBypass().catch(() => null),
      ]);
      if (!result?.ok) throw new Error("Could not load API configurations.");
      setCredentials(result.credentials ?? []);
      setSecureStorage(result.secureStorageAvailable !== false);
      setDevBypass({
        supported: bypass?.supported === true,
        enabled: bypass?.enabled === true,
      });
      setMigration(result.migration ?? null);
      return result.credentials ?? [];
    } catch (err) {
      setError(err?.message ?? "Could not load API configurations.");
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload().catch(() => {});
  }, [reload]);

  return { credentials, secureStorage, devBypass, migration, loading, error, reload, setCredentials };
}
