import { useEffect, useState } from 'react';

/**
 * Project audio discovery for commentary surfaces: the discovered WAV
 * files plus the finalized TTS manifest entries (when written), taken
 * from the existing artifact mechanism. Refreshes whenever segments
 * stream in or the run settles; failures keep the previous listing so
 * rows explain themselves instead of flashing empty.
 */
export default function useProjectAudio(projectId, script, runStatus) {
  const [audioFiles, setAudioFiles] = useState([]);
  const [ttsEntries, setTtsEntries] = useState(null);
  const [manifestInvalid, setManifestInvalid] = useState(false);

  useEffect(() => {
    if (!projectId || typeof window.api?.listArtifacts !== 'function') {
      return;
    }
    let alive = true;
    async function load() {
      try {
        const res = await window.api.listArtifacts(projectId);
        if (!alive || !res || res.ok !== true || !res.artifacts) {
          return;
        }
        const files = Array.isArray(res.artifacts.audio?.files)
          ? res.artifacts.audio.files
          : [];
        let entries = null;
        let invalid = false;
        const tts = res.artifacts.tts;
        if (tts?.present === true && tts?.invalid !== true) {
          if (typeof window.api?.readArtifact === 'function') {
            try {
              const doc = await window.api.readArtifact(projectId, 'tts');
              if (doc?.ok === true && Array.isArray(doc.data?.entries)) {
                entries = doc.data.entries;
              } else {
                invalid = true;
              }
            } catch {
              invalid = true;
            }
          }
        } else if (tts?.present === true) {
          invalid = true;
        }
        if (alive) {
          setAudioFiles(files);
          setTtsEntries(entries);
          setManifestInvalid(invalid);
        }
      } catch {
        // Keep the previous listing; rows explain themselves.
      }
    }
    load();
    return () => {
      alive = false;
    };
  }, [projectId, script, runStatus]);

  return { audioFiles, ttsEntries, manifestInvalid };
}
