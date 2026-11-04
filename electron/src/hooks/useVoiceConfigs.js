import { useCallback, useEffect, useState } from "react";

/**
 * Shared reusable-voice-configuration state for the editor Voice tab:
 * one fetch boundary, one CRUD surface. Entries are plain presets —
 * projects hold copies of applied settings, never references, so
 * deletes need no reference guard.
 */
export default function useVoiceConfigs() {
  const [configs, setConfigs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const result = await window.api.listVoiceConfigs();
      if (!result?.ok) throw new Error("Could not load saved voice configurations.");
      setConfigs(result.configs ?? []);
    } catch (err) {
      setError(err?.message ?? "Could not load saved voice configurations.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload().catch(() => {});
  }, [reload]);

  const clearMessage = useCallback(() => {
    setNotice("");
    setError("");
  }, []);

  const createConfig = useCallback(async (input) => {
    setBusy("voice-create");
    clearMessage();
    try {
      const result = await window.api.createVoiceConfig({ ...input, name: input.name.trim() });
      if (!result?.ok) throw new Error(result?.error ?? "Could not save the voice configuration.");
      setNotice(`Saved “${result.config.name}”.`);
      await reload();
      return result.config;
    } catch (err) {
      setError(err?.message ?? "Could not save the voice configuration.");
      return null;
    } finally {
      setBusy("");
    }
  }, [clearMessage, reload]);

  const updateConfig = useCallback(async (id, patch) => {
    setBusy("voice-save");
    clearMessage();
    try {
      const result = await window.api.updateVoiceConfig(id, patch);
      if (!result?.ok) throw new Error(result?.error ?? "Could not save the voice configuration.");
      setNotice(`Saved “${result.config.name}”.`);
      await reload();
      return result.config;
    } catch (err) {
      setError(err?.message ?? "Could not save the voice configuration.");
      return null;
    } finally {
      setBusy("");
    }
  }, [clearMessage, reload]);

  const deleteConfig = useCallback(async (id) => {
    setBusy("voice-delete");
    clearMessage();
    try {
      const result = await window.api.deleteVoiceConfig(id);
      if (!result?.ok) throw new Error("Could not delete the voice configuration.");
      setNotice("Voice configuration deleted.");
      await reload();
      return true;
    } catch (err) {
      setError(err?.message ?? "Could not delete the voice configuration.");
      return false;
    } finally {
      setBusy("");
    }
  }, [clearMessage, reload]);

  return {
    configs,
    loading,
    busy,
    notice,
    error,
    reload,
    clearMessage,
    createConfig,
    updateConfig,
    deleteConfig,
  };
}
