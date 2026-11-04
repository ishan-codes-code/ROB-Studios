import { createProject, deleteProject, dropApiActivityScope, getApiActivity, getProjectOutputDir, getProject as getStoredProject, isProjectDeletionLocked, listArtifacts, listProjects, openProject, readArtifact, settleProjectRun as settleStoredRun, updateProject } from '../../project-store.mjs';

function projectError(err) {
  return { ok: false, error: err?.message ?? 'Project operation failed.' };
}

function deletionBlocked(id) {
  if (typeof id === 'string' && isProjectDeletionLocked(id)) {
    return { ok: false, error: 'Project is being deleted.' };
  }
  return null;
}

export function registerProjectIpc({ ipcMain, app, workerManager, exportManager = null }) {
  ipcMain.handle('list-projects', async () => {
    try {
      return { ok: true, projects: listProjects(app.getPath('userData')) };
    } catch (err) {
      return projectError(err);
    }
  });

  ipcMain.handle('create-project', async (_event, name, sourcePath, game = null) => {
    try {
      const project = createProject(app.getPath('userData'), { name, sourcePath, game });
      return { ok: true, project };
    } catch (err) {
      return projectError(err);
    }
  });

  ipcMain.handle('open-project', async (_event, id) => {
    try {
      const blocked = deletionBlocked(id);
      if (blocked) return blocked;
      const project = openProject(app.getPath('userData'), id);
      return { ok: true, project };
    } catch (err) {
      return projectError(err);
    }
  });

  ipcMain.handle('update-project', async (_event, id, patch) => {
    try {
      const blocked = deletionBlocked(id);
      if (blocked) return blocked;
      const project = updateProject(app.getPath('userData'), id, patch);
      return { ok: true, project };
    } catch (err) {
      return projectError(err);
    }
  });

  ipcMain.handle('delete-project', async (_event, id) => {
    try {
      if (workerManager.isBusy()) {
        return { ok: false, error: 'Stop the active processing job first.' };
      }
      if (exportManager && typeof exportManager.isBusy === 'function' && exportManager.isBusy()) {
        const activeId = typeof exportManager.activeProjectId === 'function'
          ? exportManager.activeProjectId()
          : null;
        // An export reads the project's source video, so deleting that
        // project must wait. Exports of other projects do not conflict;
        // an untagged export blocks conservatively.
        if (activeId === null || activeId === id) {
          return { ok: false, error: 'An export is running for this project. Cancel it before deleting.' };
        }
      }
      const result = await deleteProject(app.getPath('userData'), id);
      // The activity file leaves with the project directory; drop the
      // cached scope so a recreated id never sees stale records.
      try { dropApiActivityScope(app.getPath('userData'), id); } catch { /* best effort */ }
      return { ok: true, ...result };
    } catch (err) {
      return projectError(err);
    }
  });

  ipcMain.handle('get-api-activity', async (_event, id) => {
    try {
      // Null/undefined id reads the settings-level scope (credential
      // checks, voice previews); a project id reads that project's
      // run history. Scopes never mix.
      if (id !== null && id !== undefined && typeof id !== 'string') {
        return { ok: false, error: 'Invalid project id.' };
      }
      return {
        ok: true,
        records: getApiActivity(app.getPath('userData'), id ?? null),
      };
    } catch (err) {
      return projectError(err);
    }
  });

  ipcMain.handle('list-artifacts', async (_event, id) => {
    try {
      return {
        ok: true,
        artifacts: listArtifacts(app.getPath('userData'), id),
      };
    } catch (err) {
      return projectError(err);
    }
  });

  ipcMain.handle('read-artifact', async (_event, id, kind, name) => {
    try {
      return {
        ok: true,
        ...readArtifact(app.getPath('userData'), id, kind, name),
      };
    } catch (err) {
      return projectError(err);
    }
  });

  }
