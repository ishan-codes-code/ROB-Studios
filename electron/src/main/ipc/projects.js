import { createProject, deleteProject, getProjectOutputDir, getProject as getStoredProject, isProjectDeletionLocked, listArtifacts, listProjects, openProject, readArtifact, settleProjectRun as settleStoredRun, updateProject } from '../../project-store.mjs';

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

  ipcMain.handle('create-project', async (_event, name, sourcePath) => {
    try {
      const project = createProject(app.getPath('userData'), { name, sourcePath });
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
      return { ok: true, ...(await deleteProject(app.getPath('userData'), id)) };
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
