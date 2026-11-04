import { useCallback, useSyncExternalStore } from "react";
import {
  MAX_ADAPTIVE_SAMPLES,
  MAX_SCRIPT_SEGMENTS,
  applyWorkerMessage,
  createInitialRunState,
} from "./worker-view.js";
import { MAX_API_ACTIVITY, applyApiActivityEvent, sanitizeActivityRecord } from "./api-activity-view.js";
import { RUN_MODES } from "./run-options.js";

/**
 * Per-project workspace sessions that outlive the editor view.
 *
 * `WorkspaceSection` unmounts whenever the user leaves the editor, which
 * used to destroy the run state (worker events, script segments, adaptive
 * history, results). Sessions live in this module instead: navigating to
 * the dashboard unmounts the view but keeps the session, and reopening
 * the project reattaches to the exact same state. No state-management
 * library — a tiny external store with immutable snapshots.
 */

const sessions = new Map();

function createSession() {
  return {
    run: createInitialRunState(),
    project: null,
    runMode: RUN_MODES.ADAPTIVE,
    adaptiveMaxFrames: null,
    runIsAdaptive: false,
    stopping: false,
    // Last accepted run's spoken-audio outcome ({enabled, reason}) so
    // the inspector can report it across mounts.
    ttsRun: null,
    // 'pending' until artifact hydration finishes (or is skipped because
    // live worker events arrived first); the editor shows a restoring
    // state until then so a project with prior work never flashes fresh.
    hydration: "pending",
    // Set by any worker message or local run mutation: live state always
    // wins over a stale hydration payload that resolves late.
    touched: false,
    // Last terminal status already toasted, so reopening a settled
    // project never replays its completion toast.
    toastNotified: null,
    // Paired API activity records for this project: live worker events
    // fold in here, and hydration backfills the persisted history.
    // Bounded like the main-process retention; records survive across
    // runs so Diagnostics shows history, not just the latest run.
    apiActivity: [],
    listeners: new Set(),
    hydrating: false,
    // Cached immutable snapshot: useSyncExternalStore requires
    // getSnapshot to return a stable reference until the store
    // notifies, otherwise React re-renders in an infinite loop.
    snapshot: null,
  };
}

function getSession(projectId) {
  let session = sessions.get(projectId);
  if (!session) {
    session = createSession();
    sessions.set(projectId, session);
  }
  return session;
}

function emit(session) {
  session.snapshot = snapshotOf(session);
  for (const listener of session.listeners) {
    listener();
  }
}

/** Drop a project's session (project deletion). Safe for unknown ids. */
export function disposeSession(projectId) {
  sessions.delete(projectId);
}

/**
 * Route one worker message to its project session. The main process
 * attaches the run's `projectId`; messages without one (older runs,
 * spawn failures) fall back to the currently open workspace.
 */
export function routeSessionTarget(activeProjectId, message) {
  if (message && typeof message.projectId === "string" && message.projectId !== "") {
    return message.projectId;
  }
  return activeProjectId;
}

/** Fold a worker message into a project's session run state. */
export function applySessionMessage(projectId, message) {
  if (typeof projectId !== "string" || projectId === "") {
    return;
  }
  const session = getSession(projectId);
  session.touched = true;
  session.run = applyWorkerMessage(session.run, message);
  if (message && message.type === "api_activity") {
    session.apiActivity = applyApiActivityEvent(session.apiActivity, message).slice(-MAX_API_ACTIVITY);
  }
  emit(session);
}

/** Merge a partial state update (or updater) into a project's session. */
export function updateSessionState(projectId, patch) {
  const session = getSession(projectId);
  const update = typeof patch === "function" ? patch(session) : patch;
  if (update && typeof update === "object") {
    if (Object.prototype.hasOwnProperty.call(update, "run")) {
      session.touched = true;
    }
    Object.assign(session, update);
    emit(session);
  }
}

function subscribeToSession(projectId, listener) {
  const session = getSession(projectId);
  session.listeners.add(listener);
  return () => {
    session.listeners.delete(listener);
  };
}

function ensureSnapshot(session) {
  if (session.snapshot === null) {
    session.snapshot = snapshotOf(session);
  }
  return session.snapshot;
}

function snapshotOf(session) {
  // Built only on mutation (see emit): subscribers always see settled
  // the store notifies on every mutation above.
  return {
    run: session.run,
    project: session.project,
    runMode: session.runMode,
    adaptiveMaxFrames: session.adaptiveMaxFrames,
    runIsAdaptive: session.runIsAdaptive,
    stopping: session.stopping,
    ttsRun: session.ttsRun,
    hydration: session.hydration,
    toastNotified: session.toastNotified,
    apiActivity: session.apiActivity,
  };
}

/** Attach a component to one project's session (stable across mounts). */
export function useWorkspaceSession(projectId) {
  const subscribe = useCallback(
    (listener) => subscribeToSession(projectId, listener),
    [projectId],
  );
  const getSnapshot = useCallback(
    () => ensureSnapshot(getSession(projectId)),
    [projectId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "stopped"]);

function statusFromProcessingStatus(processingStatus) {
  switch (processingStatus) {
    case "done":
      return "completed";
    case "error":
      return "failed";
    case "stopped":
      return "stopped";
    case "cancelled":
      return "cancelled";
    case "interrupted":
      return "failed";
    case "processing":
      return "processing";
    default:
      return "idle";
  }
}

/**
 * Rebuild a run view state from persisted artifacts (restart recovery).
 * Pure and honest: only observed artifacts become stages, samples, and
 * segments; worker logs are not persisted and stay empty; nothing is
 * invented for missing data.
 */
export function runStateFromArtifacts({ processingStatus = "idle", listing = null, manifest = null, script = null, tts = null } = {}) {
  const run = createInitialRunState();
  const status = statusFromProcessingStatus(processingStatus);
  run.status = status;
  run.settled = status !== "processing";

  const observations = listing?.observations?.count ?? 0;
  const events = listing?.events?.count ?? 0;
  const lines = listing?.commentary?.lines ?? 0;
  if (observations > 0 || events > 0 || lines > 0) {
    run.result = {
      observations,
      events,
      commentary_lines: lines,
    };
  }

  const stages = {};
  if (manifest && typeof manifest === "object") {
    stages.adaptive_vision = {
      status: "done",
      detail: {
        observations: manifest.observations ?? 0,
        requests: manifest.requests ?? 0,
      },
    };
    const iterations = Array.isArray(manifest.iterations) ? manifest.iterations : [];
    const samples = iterations
      .filter((entry) => entry && Number.isFinite(entry.timestamp) && typeof entry.speed === "string" && typeof entry.reason === "string")
      .map((entry, index, all) => ({
        timestamp: entry.timestamp,
        speed: entry.speed,
        reason: entry.reason,
        next: index + 1 < all.length && Number.isFinite(all[index + 1].timestamp) ? all[index + 1].timestamp : null,
      }))
      .slice(-MAX_ADAPTIVE_SAMPLES);
    if (samples.length > 0 || typeof manifest.requests === "number") {
      run.adaptive = {
        samples,
        observations: manifest.observations ?? 0,
        requests: manifest.requests ?? 0,
      };
    }
  }
  if (listing?.state?.present === true && listing.state.invalid !== true) {
    stages.state_rebuild = { status: "done", detail: null };
  }
  if (listing?.events?.present === true && listing.events.invalid !== true) {
    stages.event_detection = { status: "done", detail: { events } };
  }
  if (listing?.commentary?.present === true && listing.commentary.invalid !== true) {
    stages.commentary = { status: "done", detail: { lines } };
  }
  let scriptStatus = null;
  if (script && typeof script === "object" && Array.isArray(script.segments)) {
    scriptStatus = typeof script.status === "string" ? script.status : "success";
    stages.script = { status: "done", detail: { status: scriptStatus } };
    const ttsEntries = Array.isArray(tts?.entries) ? tts.entries : [];
    const ttsById = new Map(
      ttsEntries.filter((entry) => entry && typeof entry.segment_id === "string").map((entry) => [entry.segment_id, entry]),
    );
    const segments = script.segments
      .filter((segment) => segment && typeof segment.segment_id === "string" && Number.isFinite(segment.timestamp_seconds) && typeof segment.text === "string")
      .map((segment) => {
        const ttsEntry = ttsById.get(segment.segment_id);
        const ttsStatus = ttsEntry?.status;
        return {
          utteranceId: segment.segment_id,
          timestamp: segment.timestamp_seconds,
          text: segment.text,
          sourceClaimIds: Array.isArray(segment.source_claim_ids) ? segment.source_claim_ids.filter((id) => typeof id === "string") : [],
          priority: null,
          scriptStatus: "worded",
          ttsStatus: ttsStatus === "success" || ttsStatus === "error" || ttsStatus === "skipped" ? ttsStatus : null,
          ttsError: ttsStatus === "error" && typeof ttsEntry?.error === "string" ? ttsEntry.error : null,
        };
      })
      .slice(-MAX_SCRIPT_SEGMENTS);
    if (segments.length > 0) {
      run.script = { segments };
    }
  }
  if (listing?.tts?.present === true && listing.tts.invalid !== true) {
    const entries = Array.isArray(tts?.entries) ? tts.entries : [];
    stages.tts = {
      status: "done",
      detail: {
        status: typeof tts?.status === "string" ? tts.status : "success",
        segments: entries.length,
        succeeded: entries.filter((entry) => entry?.status === "success").length,
        failed: entries.filter((entry) => entry?.status === "error").length,
      },
    };
  }
  run.stages = stages;

  if (status === "failed") {
    const manifestError = manifest && typeof manifest.error?.message === "string" ? manifest.error.message : null;
    const scriptError = scriptStatus === "error" && typeof script?.error === "string" ? script.error : null;
    run.error = {
      stage: "worker",
      message: manifestError ?? scriptError ?? "A previous run failed.",
    };
  }
  return run;
}

async function readDoc(api, projectId, kind) {
  try {
    const res = await api.readArtifact(projectId, kind);
    if (res?.ok === true && res.data && typeof res.data === "object") {
      return res.data;
    }
  } catch {
    // Missing or unreadable artifact: hydration continues without it.
  }
  return null;
}

/**
 * Hydrate a project's session from persisted artifacts. Runs once per
 * session; resolves immediately on later mounts. If live worker events
 * arrived first, they win and the artifact snapshot is discarded.
 */
export function hydrateSession(projectId, api) {
  const session = getSession(projectId);
  if (session.hydration === "ready" || session.hydrating) {
    return Promise.resolve();
  }
  session.hydrating = true;
  return (async () => {
    try {
      const project = session.project;
      let listing = null;
      try {
        const res = await api.listArtifacts(projectId);
        if (res?.ok === true && res.artifacts && typeof res.artifacts === "object") {
          listing = res.artifacts;
        }
      } catch {
        // Listing failure hydrates to the default idle state below.
      }
      const [manifest, script, tts] = await Promise.all([
        listing?.manifest?.present === true && listing.manifest.invalid !== true ? readDoc(api, projectId, "manifest") : null,
        listing?.script?.present === true && listing.script.invalid !== true ? readDoc(api, projectId, "script") : null,
        listing?.tts?.present === true && listing.tts.invalid !== true ? readDoc(api, projectId, "tts") : null,
      ]);
      let activity = null;
      try {
        if (typeof api.getApiActivity === "function") {
          const res = await api.getApiActivity(projectId);
          if (res?.ok === true && Array.isArray(res.records)) {
            activity = res.records
              .map((entry) => sanitizeActivityRecord(entry))
              .filter((record) => record !== null)
              .slice(-MAX_API_ACTIVITY);
          }
        }
      } catch {
        // Activity history is advisory: hydration continues without it.
      }
      if (!session.touched) {
        session.run = runStateFromArtifacts({
          processingStatus: project?.processingStatus ?? "idle",
          listing,
          manifest,
          script,
          tts,
        });
        if (activity !== null) {
          session.apiActivity = activity;
        }
        if (TERMINAL_STATUSES.has(session.run.status)) {
          session.toastNotified = session.run.status;
        }
      }
    } finally {
      session.hydration = "ready";
      emit(session);
    }
  })();
}
