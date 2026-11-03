import { useEffect, useRef, useState } from 'react';
import { projectMediaUrl } from '@/lib/format.js';
import {
  computePeaks,
  getSharedAudioContext,
  loadAudioBuffer,
  releaseProjectAudio,
  WAVEFORM_PEAK_COUNT,
} from '@/lib/waveform.js';

const DECODE_CONCURRENCY = 4;

function rowOrder(row) {
  return [typeof row.timestamp === 'number' ? row.timestamp : Number.POSITIVE_INFINITY, row.key];
}

/**
 * Decode every ready row's WAV (timestamp order, bounded concurrency)
 * into render metadata: `meta` maps row keys to `{ peaks, duration }`
 * and `decodeErrors` maps keys to honest failure messages. Buffers
 * stay in the waveform cache for playback; only peaks and durations
 * enter React state. Project switches abort in-flight work and evict
 * the old project's buffers.
 */
export default function useCommentaryAudio(projectId, rows, runStatus = 'idle') {
  const [meta, setMeta] = useState(() => new Map());
  const [decodeErrors, setDecodeErrors] = useState(() => new Map());
  const [decodeBlocked, setDecodeBlocked] = useState(false);
  const settledRef = useRef(new Set());
  const prevProjectRef = useRef(projectId);
  const prevRunStatus = useRef(runStatus);

  useEffect(() => {
    const prev = prevProjectRef.current;
    prevProjectRef.current = projectId;
    if (prev && prev !== projectId) {
      releaseProjectAudio(prev);
    }
    settledRef.current = new Set();
    setMeta(new Map());
    setDecodeErrors(new Map());
    setDecodeBlocked(false);
    return () => {
      if (projectId) {
        releaseProjectAudio(projectId);
      }
    };
  }, [projectId]);

  // A new run reuses segment filenames with fresh bytes: forget
  // decoded audio when processing starts so nothing stale survives.
  useEffect(() => {
    const started = prevRunStatus.current !== 'processing' && runStatus === 'processing';
    prevRunStatus.current = runStatus;
    if (started) {
      if (projectId) {
        releaseProjectAudio(projectId);
      }
      settledRef.current = new Set();
      setMeta(new Map());
      setDecodeErrors(new Map());
    }
  }, [projectId, runStatus]);

  useEffect(() => {
    if (!projectId || !Array.isArray(rows)) {
      return;
    }
    const settled = settledRef.current;
    const pending = rows
      .filter(
        (row) =>
          row &&
          row.state === 'ready' &&
          typeof row.scope === 'string' &&
          typeof row.name === 'string' &&
          !settled.has(row.key),
      )
      .sort((a, b) => {
        const [at, ak] = rowOrder(a);
        const [bt, bk] = rowOrder(b);
        return at === bt ? (ak < bk ? -1 : 1) : at - bt;
      });
    if (pending.length === 0) {
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    let cursor = 0;

    async function ingest(row) {
      const context = getSharedAudioContext();
      const { buffer } = await loadAudioBuffer({
        projectId,
        key: row.key,
        url: projectMediaUrl(projectId, row.scope, row.name),
        audioContext: context,
        signal: controller.signal,
      });
      const channels = [];
      try {
        channels.push(buffer.getChannelData(0));
        if (buffer.numberOfChannels > 1) {
          channels.push(buffer.getChannelData(1));
        }
      } catch {
        // Unreadable channels render flat; the buffer still plays.
      }
      return { peaks: computePeaks(channels, WAVEFORM_PEAK_COUNT), duration: buffer.duration };
    }

    async function worker() {
      while (!cancelled) {
        const row = pending[cursor];
        cursor += 1;
        if (!row) {
          return;
        }
        try {
          const entry = await ingest(row);
          if (cancelled) {
            return;
          }
          settled.add(row.key);
          setMeta((prev) => new Map(prev).set(row.key, entry));
        } catch (err) {
          if (cancelled || err?.name === 'AbortError') {
            return;
          }
          settled.add(row.key);
          if (/Web Audio is unavailable/.test(err?.message ?? '')) {
            setDecodeBlocked(true);
          }
          setDecodeErrors((prev) =>
            new Map(prev).set(row.key, err?.message ?? 'Could not decode audio.'),
          );
        }
      }
    }

    const pool = Array.from({ length: Math.min(DECODE_CONCURRENCY, pending.length) }, () =>
      worker(),
    );
    void Promise.all(pool);
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [projectId, rows]);

  return { meta, decodeErrors, decodeBlocked };
}
