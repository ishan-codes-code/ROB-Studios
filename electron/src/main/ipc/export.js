/**
 * Main-process handlers for MVP video export: validate the project
 * and renderer-supplied rows, resolve the bundled FFmpeg binary,
 * ask for an output path, and supervise the encode. Every renderer
 * value is re-validated here; file access stays main-side behind
 * the existing project allow-lists (no renderer-chosen paths are
 * ever read except the save-dialog output).
 */

import path from 'node:path';
import { selectSingleChannel } from '../../lib/commentary-timeline.js';
import {
  parseWavDuration,
  resolveFfmpegPath,
  sanitizeExportBasename,
  toStartMs,
  withMp4Extension,
} from '../../export-media.mjs';
import { getProject, listArtifacts, resolveProjectMedia } from '../../project-store.mjs';

const MAX_WAV_BYTES = 256 * 1024 * 1024;

function defaultResolveFfmpeg(app) {
  return resolveFfmpegPath({
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
  });
}

function isUsableRow(row) {
  return (
    row !== null &&
    typeof row === 'object' &&
    row.state === 'ready' &&
    typeof row.timestamp === 'number' &&
    Number.isFinite(row.timestamp) &&
    row.timestamp >= 0 &&
    typeof row.scope === 'string' &&
    typeof row.name === 'string'
  );
}

/**
 * Re-verify renderer rows against the project's own listing: only
 * files the main process lists, stats, and duration-parses become
 * export candidates. Returns `[{ wavPath, timestamp, duration }]`.
 */
function collectCandidates({ fs, userDataPath, projectId, rows }) {
  if (!Array.isArray(rows)) {
    return [];
  }
  let listing;
  try {
    listing = listArtifacts(userDataPath, projectId);
  } catch {
    return [];
  }
  const listed = new Set(
    (listing.audio?.files ?? []).map((file) => `${file.scope}\n${file.name}`),
  );
  const candidates = [];
  for (const row of rows) {
    if (!isUsableRow(row) || !listed.has(`${row.scope}\n${row.name}`)) {
      continue;
    }
    let wavPath;
    try {
      wavPath = resolveProjectMedia(userDataPath, projectId, row.scope, row.name);
    } catch {
      continue;
    }
    let stat;
    try {
      stat = fs.statSync(wavPath);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_WAV_BYTES) {
      continue;
    }
    let duration;
    try {
      duration = parseWavDuration(fs.readFileSync(wavPath));
    } catch {
      continue;
    }
    if (!(duration > 0)) {
      continue;
    }
    candidates.push({ wavPath, timestamp: row.timestamp, duration });
  }
  return candidates;
}

/**
 * Finalize the encode plan once the probe reports the source shape:
 * drop segments at/past the video end, then apply the timeline's
 * shared single-channel overlap rule (earliest starter wins).
 */
export function resolveExportPlan(candidates, { duration }) {
  const audible = (Array.isArray(candidates) ? candidates : [])
    .filter((item) => item && item.timestamp < duration)
    .map((item) => ({ ...item, start: item.timestamp, end: item.timestamp + item.duration }))
    .sort((a, b) => (a.start === b.start ? (a.wavPath < b.wavPath ? -1 : 1) : a.start - b.start));
  const { kept } = selectSingleChannel(audible);
  if (kept.length === 0) {
    throw new Error('No commentary falls within the video duration.');
  }
  return {
    wavPaths: kept.map((item) => item.wavPath),
    segments: kept.map((item) => ({ startMs: toStartMs(item.start) })),
  };
}

export function registerExportIpc({
  ipcMain,
  app,
  dialog,
  fs,
  exportManager,
  sendExportEvent,
  getMainWindow,
  resolveFfmpeg = defaultResolveFfmpeg,
}) {
  ipcMain.handle('export-video', async (_event, projectId, rows) => {
    try {
      let project;
      try {
        project = getProject(app.getPath('userData'), projectId);
      } catch {
        return { ok: false, error: 'Project not found.' };
      }
      const sourcePath = project?.sourceVideo?.path;
      let sourceStat = null;
      try {
        sourceStat = sourcePath ? fs.statSync(sourcePath) : null;
      } catch {
        sourceStat = null;
      }
      if (typeof sourcePath !== 'string' || !sourceStat?.isFile()) {
        return { ok: false, error: 'The source video file is missing.' };
      }
      const executable = resolveFfmpeg(app);
      if (!executable) {
        return { ok: false, error: 'FFmpeg is unavailable. Reinstall dependencies to restore export.' };
      }
      const candidates = collectCandidates({
        fs,
        userDataPath: app.getPath('userData'),
        projectId,
        rows,
      });
      if (candidates.length === 0) {
        return {
          ok: false,
          error: 'No usable commentary audio. Generate spoken audio before exporting.',
        };
      }
      let videosDir;
      try {
        videosDir = app.getPath('videos');
      } catch {
        videosDir = app.getPath('documents');
      }
      const defaultPath = path.join(
        videosDir,
        `${sanitizeExportBasename(project?.name)}-commentary.mp4`,
      );
      let selection;
      try {
        selection = await dialog.showSaveDialog(getMainWindow(), {
          title: 'Export commentary video',
          defaultPath,
          filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
        });
      } catch {
        return { ok: false, error: 'Could not open the save dialog.' };
      }
      if (selection?.canceled || typeof selection?.filePath !== 'string' || selection.filePath === '') {
        return { ok: true, canceled: true };
      }
      const outputPath = withMp4Extension(selection.filePath);
      const started = await exportManager.start({
        executable,
        sourcePath,
        outputPath,
        resolvePlan: async ({ duration, hasAudio }) => ({
          ...resolveExportPlan(candidates, { duration }),
          hasGameAudio: hasAudio,
        }),
        onEvent: (event) => sendExportEvent({ projectId, ...event }),
      });
      if (started.started) {
        return { ok: true, outputPath };
      }
      if (started.reason === 'busy') {
        return { ok: false, error: 'An export is already running.' };
      }
      if (started.reason === 'cancelled') {
        return { ok: true, canceled: true };
      }
      return { ok: false, error: started.error ?? 'Export could not start.' };
    } catch {
      return { ok: false, error: 'Export could not start.' };
    }
  });

  ipcMain.handle('cancel-export', async () => {
    try {
      const stopped = await exportManager.cancel();
      return { ok: true, stopped };
    } catch {
      return { ok: false, error: 'Could not cancel the export.' };
    }
  });
}
