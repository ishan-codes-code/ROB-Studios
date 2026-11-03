import { useCallback, useEffect, useRef, useState } from 'react';
import { findLateKeys, planPlayback, samePlaybackWindow } from '@/lib/commentary-timeline.js';
import { formatMediaTime } from '@/lib/format.js';
import { getSharedAudioContext, releaseSharedAudioContext } from '@/lib/waveform.js';

/**
 * Synchronized commentary playback with the source video as the master
 * clock. Video media events (play/pause/seeking/seeked/ended/
 * ratechange/waiting/playing) plus a reconcile loop driven by
 * requestAnimationFrame while playing keep one commentary channel
 * scheduled against `video.currentTime` — never a separate clock, no
 * setInterval timing. Seeks invalidate stale audio, rate changes apply
 * live, and project switches tear everything down. The playhead and
 * clock update through refs (no per-frame React state); `activeKey`
 * only changes on segment boundaries.
 */
export default function useCommentaryPlayback({
  videoRef,
  projectId,
  intervals,
  getBuffer,
  playheadRef,
  timeRef,
  runStatus = 'idle',
}) {
  const [activeKey, setActiveKey] = useState(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const intervalsRef = useRef(intervals);
  const getBufferRef = useRef(getBuffer);
  intervalsRef.current = intervals;
  getBufferRef.current = getBuffer;
  const liveRef = useRef({
    source: null,
    window: null,
    soundingKey: null,
    missed: new Set(),
    knownIntervals: [],
    raf: 0,
  });
  const prevRunStatus = useRef(runStatus);

  const setActiveKeyIfChanged = useCallback((key) => {
    setActiveKey((prev) => (prev === key ? prev : key));
  }, []);

  const stopActive = useCallback(() => {
    const live = liveRef.current;
    const source = live.source;
    live.source = null;
    live.window = null;
    live.soundingKey = null;
    if (source) {
      try {
        source.onended = null;
      } catch {
        // Detach-only; teardown must never throw.
      }
      try {
        source.stop();
      } catch {
        // Already stopped or never started.
      }
      try {
        source.disconnect();
      } catch {
        // Already disconnected.
      }
    }
  }, []);

  const updatePlayhead = useCallback(() => {
    const video = videoRef?.current;
    if (!video) {
      return;
    }
    const now = video.currentTime;
    const duration = video.duration;
    if (playheadRef?.current) {
      if (Number.isFinite(duration) && duration > 0 && Number.isFinite(now)) {
        playheadRef.current.style.left = `${Math.min(100, Math.max(0, (now / duration) * 100))}%`;
        playheadRef.current.style.opacity = '1';
      } else {
        playheadRef.current.style.opacity = '0';
      }
    }
    if (timeRef?.current) {
      timeRef.current.textContent = `${formatMediaTime(now)} / ${formatMediaTime(duration)}`;
    }
  }, [videoRef, playheadRef, timeRef]);

  const reconcile = useCallback(() => {
    const video = videoRef?.current;
    const live = liveRef.current;
    if (!video || video.paused || video.ended) {
      return;
    }
    const plan = planPlayback({
      intervals: intervalsRef.current,
      now: video.currentTime,
      missedKeys: live.missed,
      activeWindow: live.window,
    });
    for (const key of plan.skipKeys) {
      live.missed.add(key);
    }
    if (plan.stopActive) {
      // Sounding audio survives transient metadata churn (mid-run
      // renames, decode gaps): only a window the video has left —
      // or an explicit pause/seek — ends it.
      const withinWindow =
        live.window &&
        live.window.start <= video.currentTime &&
        video.currentTime < live.window.end;
      if (!withinWindow) {
        stopActive();
      } else {
        return;
      }
    }
    if (plan.audible && plan.audible.key !== live.soundingKey) {
      // Same sounding window under a new key (mid-run rename):
      // adopt the key, never restart the source node.
      if (live.source && live.window && samePlaybackWindow(plan.audible, live.window)) {
        live.soundingKey = plan.audible.key;
        live.window = { start: plan.audible.start, end: plan.audible.end };
        setActiveKeyIfChanged(plan.audible.key);
        return;
      }
      stopActive();
      const buffer = getBufferRef.current?.(plan.audible.key) ?? null;
      if (!buffer) {
        live.missed.add(plan.audible.key);
        setActiveKeyIfChanged(null);
        return;
      }
      let context;
      try {
        context = getSharedAudioContext();
      } catch {
        setAudioBlocked(true);
        return;
      }
      if (context.state === 'suspended') {
        void context.resume().catch(() => {});
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      try {
        source.playbackRate.value = video.playbackRate || 1;
      } catch {
        // Default rate stands when the video reports garbage.
      }
      source.connect(context.destination);
      source.onended = () => {
        if (liveRef.current.source === source) {
          liveRef.current.source = null;
          liveRef.current.window = null;
          liveRef.current.soundingKey = null;
          setActiveKeyIfChanged(null);
        }
      };
      const offset = Math.min(Math.max(0, plan.audible.offset), buffer.duration);
      try {
        source.start(0, offset);
      } catch {
        live.missed.add(plan.audible.key);
        setActiveKeyIfChanged(null);
        return;
      }
      live.source = source;
      live.window = { start: plan.audible.start, end: plan.audible.end };
      live.soundingKey = plan.audible.key;
      setActiveKeyIfChanged(plan.audible.key);
    } else if (!plan.audible && !live.source) {
      setActiveKeyIfChanged(null);
    }
  }, [videoRef, stopActive, setActiveKeyIfChanged]);

  const stopLoop = useCallback(() => {
    const live = liveRef.current;
    if (live.raf !== 0) {
      cancelAnimationFrame(live.raf);
      live.raf = 0;
    }
  }, []);

  const startLoop = useCallback(() => {
    const live = liveRef.current;
    if (live.raf !== 0) {
      return;
    }
    const tick = () => {
      live.raf = requestAnimationFrame(tick);
      updatePlayhead();
      reconcile();
    };
    live.raf = requestAnimationFrame(tick);
  }, [updatePlayhead, reconcile]);

  // Full teardown when the project changes; the context itself is
  // released only on unmount (creation is expensive, buffers are not).
  useEffect(() => {
    const live = liveRef.current;
    stopLoop();
    stopActive();
    live.missed = new Set();
    live.knownIntervals = [];
    setActiveKey(null);
    setAudioBlocked(false);
    return () => {
      stopLoop();
      stopActive();
    };
  }, [projectId, stopLoop, stopActive]);

  useEffect(
    () => () => {
      void releaseSharedAudioContext();
    },
    [],
  );

  // Intervals decoded mid-pass whose start already passed are missed
  // for this pass; parked video never accrues lateness (pressing play
  // or seeking re-enables whatever is at the new position). Fresh
  // intervals also unblock audio at the current position.
  useEffect(() => {
    const live = liveRef.current;
    const video = videoRef?.current;
    if (video && !video.paused && !video.ended) {
      for (const key of findLateKeys(live.knownIntervals, intervals, video.currentTime)) {
        live.missed.add(key);
      }
    }
    live.knownIntervals = intervals;
    reconcile();
  }, [intervals, reconcile, videoRef]);

  // A new run invalidates old commentary: stop stale audio and forget
  // pass state so fresh segments schedule cleanly. Settling keeps
  // playing; only entering processing resets.
  useEffect(() => {
    const started = prevRunStatus.current !== 'processing' && runStatus === 'processing';
    prevRunStatus.current = runStatus;
    if (started) {
      stopLoop();
      stopActive();
      liveRef.current.missed = new Set();
      liveRef.current.knownIntervals = [];
      setActiveKey(null);
    }
  }, [runStatus, stopLoop, stopActive]);

  useEffect(() => {
    const video = videoRef?.current;
    if (!video || typeof video.addEventListener !== 'function') {
      return;
    }
    const live = liveRef.current;
    const onPlay = () => {
      try {
        const context = getSharedAudioContext();
        if (context.state === 'suspended') {
          void context.resume().catch(() => {});
        }
      } catch {
        setAudioBlocked(true);
      }
      startLoop();
      updatePlayhead();
      reconcile();
    };
    const onPause = () => {
      stopLoop();
      stopActive();
      setActiveKeyIfChanged(null);
      updatePlayhead();
    };
    const onSeeking = () => {
      stopLoop();
      stopActive();
      setActiveKeyIfChanged(null);
    };
    const onSeeked = () => {
      const now = video.currentTime;
      const starts = new Map(intervalsRef.current.map((interval) => [interval.key, interval.start]));
      for (const key of Array.from(live.missed)) {
        const start = starts.get(key);
        if (start === undefined || start >= now) {
          live.missed.delete(key);
        }
      }
      updatePlayhead();
      if (!video.paused && !video.ended) {
        startLoop();
      }
      reconcile();
    };
    const onEnded = () => {
      stopLoop();
      stopActive();
      live.missed = new Set();
      setActiveKeyIfChanged(null);
      updatePlayhead();
    };
    const onRateChange = () => {
      if (live.source) {
        try {
          live.source.playbackRate.value = video.playbackRate || 1;
        } catch {
          // The sounding source keeps its previous rate.
        }
      }
    };
    // Buffering stalls freeze the video clock: stop commentary rather
    // than drift, and reschedule when playback resumes.
    const onWaiting = () => {
      stopActive();
      setActiveKeyIfChanged(null);
    };
    const onPlaying = () => {
      startLoop();
      reconcile();
    };
    const onMetadata = () => updatePlayhead();
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('seeking', onSeeking);
    video.addEventListener('seeked', onSeeked);
    video.addEventListener('ended', onEnded);
    video.addEventListener('ratechange', onRateChange);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('loadedmetadata', onMetadata);
    video.addEventListener('durationchange', onMetadata);
    updatePlayhead();
    return () => {
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('seeking', onSeeking);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('ratechange', onRateChange);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('loadedmetadata', onMetadata);
      video.removeEventListener('durationchange', onMetadata);
    };
  }, [
    projectId,
    videoRef,
    startLoop,
    stopLoop,
    stopActive,
    reconcile,
    updatePlayhead,
    setActiveKeyIfChanged,
  ]);

  return { activeKey, audioBlocked };
}
