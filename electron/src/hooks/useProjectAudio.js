import { useEffect, useMemo, useRef, useState } from 'react';
import { selectFreshTtsEntries } from '../lib/audio-rows.js';

/**
 * Project audio discovery for commentary surfaces: the discovered WAV
 * files plus the finalized TTS manifest entries (when written), taken
 * from the existing artifact mechanism. Refreshes whenever segments
 * stream in, a stage settles (finalized manifests land on
 * `stage_completed`, e.g. the streaming TTS rename of `u-*.wav` to
 * `segment-*.wav`), or the run settles; failures keep the previous
 * listing so rows explain themselves instead of flashing empty.
 *
 * Session scoping: switching projects clears the view before the fresh
 * listing loads so segments never leak across projects, and a
 * persisted manifest renders only when it belongs to this session's
 * run (see `selectFreshTtsEntries`) so a previous run's rows never
 * shadow live segments. Only the latest listing request commits, so
 * rapid segments cannot resolve out of order.
 */
export default function useProjectAudio(projectId, script, runStatus, stages, ttsGeneration) {
  const [audioFiles, setAudioFiles] = useState([]);
  const [ttsEntries, setTtsEntries] = useState(null);
  const [manifestInvalid, setManifestInvalid] = useState(false);
  const prevProjectRef = useRef(projectId);
  const requestRef = useRef(0);

  useEffect(() => {
    const projectChanged = prevProjectRef.current !== projectId;
    prevProjectRef.current = projectId;
    if (projectChanged) {
      setAudioFiles([]);
      setTtsEntries(null);
      setManifestInvalid(false);
    }
    if (!projectId || typeof window.api?.listArtifacts !== 'function') {
      return;
    }
    const request = requestRef.current + 1;
    requestRef.current = request;
    let alive = true;
    async function load() {
      try {
        const res = await window.api.listArtifacts(projectId);
        if (!alive || request !== requestRef.current || !res || res.ok !== true || !res.artifacts) {
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
              if (request !== requestRef.current) {
                return;
              }
              if (doc?.ok === true && Array.isArray(doc.data?.entries)) {
                // A stale manifest (previous run) simply selects the
                // live view; it is not an error worth flagging.
                entries = selectFreshTtsEntries(doc.data, ttsGeneration);
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
        if (alive && request === requestRef.current) {
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
  }, [projectId, script, runStatus, stages, ttsGeneration]);

  // Stable identity: consumers memo their joins on this object, and the
  // workspace re-renders on every worker message.
  return useMemo(
    () => ({ audioFiles, ttsEntries, manifestInvalid }),
    [audioFiles, ttsEntries, manifestInvalid],
  );
}
