import { useCallback, useEffect, useState } from "react";

/**
 * Shared game-library state for the Game Profiles and Commentary
 * Presets sections: one fetch boundary, one CRUD surface, identical
 * validation and reference-guard messaging on both pages. Profile
 * duplication is composed client-side from create (the store has no
 * duplicate primitive); preset duplication uses the main-process
 * operation. Built-ins stay immutable: edits to them always create.
 */
export default function useGameLibrary() {
  const [profiles, setProfiles] = useState([]);
  const [presets, setPresets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [profileRes, presetRes] = await Promise.all([
        window.api.listGameProfiles(),
        window.api.listPresets(null),
      ]);
      if (!profileRes?.ok) throw new Error("Could not load game profiles.");
      if (!presetRes?.ok) throw new Error("Could not load commentary presets.");
      setProfiles(profileRes.profiles ?? []);
      setPresets(presetRes.presets ?? []);
    } catch (err) {
      setError(err?.message ?? "Could not load the game library.");
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

  const failWithReferences = useCallback((result, fallback) => {
    if (Array.isArray(result?.referencedBy) && result.referencedBy.length > 0) {
      return `In use by ${result.referencedBy.length} project(s): ${result.referencedBy.slice(0, 3).join(", ")}. Change those projects first.`;
    }
    return fallback;
  }, []);

  const createProfile = useCallback(async ({ name, context }) => {
    setBusy("profile-create");
    clearMessage();
    try {
      const result = await window.api.createGameProfile({ name: name.trim(), context });
      if (!result?.ok) throw new Error("Could not create the game profile. The name may already be in use.");
      setNotice(`Created profile “${result.profile.name}”.`);
      await reload();
      return result.profile;
    } catch (err) {
      setError(err?.message ?? "Could not create the game profile.");
      return null;
    } finally {
      setBusy("");
    }
  }, [clearMessage, reload]);

  const updateProfile = useCallback(async (id, patch) => {
    setBusy("profile-save");
    clearMessage();
    try {
      const result = await window.api.updateGameProfile(id, patch);
      if (!result?.ok) throw new Error("Could not save the game profile. The name may already be in use.");
      setNotice("Game profile saved.");
      await reload();
      return result.profile;
    } catch (err) {
      setError(err?.message ?? "Could not save the game profile.");
      return null;
    } finally {
      setBusy("");
    }
  }, [clearMessage, reload]);

  const deleteProfile = useCallback(async (id) => {
    setBusy("profile-delete");
    clearMessage();
    try {
      const result = await window.api.deleteGameProfile(id);
      if (!result?.ok) throw new Error(failWithReferences(result, "Could not delete the game profile."));
      setNotice("Game profile deleted.");
      await reload();
      return true;
    } catch (err) {
      setError(err?.message ?? "Could not delete the game profile.");
      return false;
    } finally {
      setBusy("");
    }
  }, [clearMessage, failWithReferences, reload]);

  const duplicateProfile = useCallback(async (profile) => {
    setBusy("profile-duplicate");
    clearMessage();
    try {
      const taken = new Set(profiles.map((entry) => entry.name.toLowerCase()));
      let candidate = `${profile.name} (copy)`;
      let suffix = 2;
      while (taken.has(candidate.toLowerCase())) {
        candidate = `${profile.name} (copy ${suffix})`;
        suffix += 1;
      }
      const result = await window.api.createGameProfile({ name: candidate, context: profile.context ?? "" });
      if (!result?.ok) throw new Error("Could not duplicate the game profile.");
      setNotice(`Duplicated as “${result.profile.name}”. Presets are not copied.`);
      await reload();
      return result.profile;
    } catch (err) {
      setError(err?.message ?? "Could not duplicate the game profile.");
      return null;
    } finally {
      setBusy("");
    }
  }, [clearMessage, profiles, reload]);

  const createPreset = useCallback(async (input) => {
    setBusy("preset-save");
    clearMessage();
    try {
      const result = await window.api.createPreset({ ...input, name: input.name.trim() });
      if (!result?.ok) throw new Error("Could not create the preset. The name may already be in use.");
      setNotice(`Created preset “${result.preset.name}”.`);
      await reload();
      return result.preset;
    } catch (err) {
      setError(err?.message ?? "Could not create the preset.");
      return null;
    } finally {
      setBusy("");
    }
  }, [clearMessage, reload]);

  const updatePreset = useCallback(async (id, patch) => {
    setBusy("preset-save");
    clearMessage();
    try {
      const result = await window.api.updatePreset(id, patch);
      if (!result?.ok) throw new Error("Could not save the preset. The name may already be in use.");
      setNotice("Preset saved.");
      await reload();
      return result.preset;
    } catch (err) {
      setError(err?.message ?? "Could not save the preset.");
      return null;
    } finally {
      setBusy("");
    }
  }, [clearMessage, reload]);

  const duplicatePreset = useCallback(async (id, name = null) => {
    setBusy("preset-duplicate");
    clearMessage();
    try {
      const result = await window.api.duplicatePreset(id, name);
      if (!result?.ok) throw new Error("Could not duplicate the preset.");
      setNotice(`Duplicated as “${result.preset.name}”.`);
      await reload();
      return result.preset;
    } catch (err) {
      setError(err?.message ?? "Could not duplicate the preset.");
      return null;
    } finally {
      setBusy("");
    }
  }, [clearMessage, reload]);

  const deletePreset = useCallback(async (id) => {
    setBusy("preset-delete");
    clearMessage();
    try {
      const result = await window.api.deletePreset(id);
      if (!result?.ok) throw new Error(failWithReferences(result, "Could not delete the preset."));
      setNotice("Preset deleted.");
      await reload();
      return true;
    } catch (err) {
      setError(err?.message ?? "Could not delete the preset.");
      return false;
    } finally {
      setBusy("");
    }
  }, [clearMessage, failWithReferences, reload]);

  return {
    profiles,
    presets,
    loading,
    busy,
    notice,
    error,
    reload,
    clearMessage,
    createProfile,
    updateProfile,
    deleteProfile,
    duplicateProfile,
    createPreset,
    updatePreset,
    duplicatePreset,
    deletePreset,
  };
}
