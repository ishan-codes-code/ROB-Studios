import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AutoHeight } from "@animate-ui/react/primitives/effects/auto-height";
import { toast } from "sonner";
import {
  ChevronDown,
  Clapperboard,
  FolderOpen,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { cn } from "cn";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.jsx";
import { Badge } from "@/components/ui/badge.jsx";
import { Button } from "@/components/ui/button.jsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.jsx";
import { Skeleton } from "@/components/ui/skeleton.jsx";
import { Spinner } from "@/components/ui/spinner.jsx";
import GlassCard from "@/primitives/GlassCard.jsx";
import LiveCommentaryHero from "./LiveCommentaryHero.jsx";
import {
  extensionOf,
  fileNameOf,
  formatBytes,
  timeAgo,
} from "@/lib/format.js";
import { EASING, MOTION } from "@/lib/tokens.js";

const STATUS_BADGE = {
  idle: "outline",
  processing: "default",
  done: "secondary",
  error: "destructive",
  cancelled: "outline",
  interrupted: "outline",
};

function bridgeError() {
  return new Error("Worker bridge unavailable (running outside Electron?).");
}

function ProjectRow({ project, onOpen, onRequestDelete, deleting, deleteDisabled }) {
  return (
    <motion.li
      initial={false}
      exit={{ opacity: 0, x: 12 }}
      transition={{ duration: MOTION.fast, ease: EASING.entrance }}
      className="flex items-center gap-3 px-4 py-3"
    >
      <button
        type="button"
        onClick={() => onOpen(project.id)}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[13px] font-semibold text-foreground">
            {project.name}
          </span>
          <span className="truncate font-mono text-xs text-subtle">
            {fileNameOf(project.sourceVideo.path)} ·{" "}
            {formatBytes(project.sourceVideo.sizeBytes)} · opened{" "}
            {timeAgo(project.lastOpenedAt)}
          </span>
        </span>
        <Badge variant={STATUS_BADGE[project.processingStatus] ?? "outline"}>
          {project.processingStatus}
        </Badge>
      </button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Delete ${project.name}`}
        title={`Delete ${project.name}`}
        disabled={deleting || deleteDisabled}
        onClick={() => onRequestDelete(project)}
      >
        {deleting ? <Spinner /> : <Trash2 />}
      </Button>
    </motion.li>
  );
}

function ProjectListSkeleton() {
  return (
    <GlassCard className="p-0" role="status" aria-label="Loading projects">
      <span className="sr-only">Loading projects…</span>
      <ul aria-hidden className="flex flex-col divide-y divide-border">
        {[0, 1, 2].map((index) => (
          <li key={index} className="flex items-center gap-3 px-4 py-3">
            <span className="flex min-w-0 flex-1 flex-col gap-1.5">
              <Skeleton className="h-4 w-1/3 motion-reduce:animate-none" />
              <Skeleton className="h-3 w-2/3 motion-reduce:animate-none" />
            </span>
            <Skeleton className="h-5 w-14 rounded-full motion-reduce:animate-none" />
          </li>
        ))}
      </ul>
    </GlassCard>
  );
}

/**
 * Product-first dashboard. The Live AI Commentary hero states where the
 * product is headed; the recorded-gameplay library below keeps the
 * existing project workflow (native picker → name → isolated copy →
 * open workspace) with identical IPC semantics. Deletion is a deliberate
 * typed-name confirmation through the same `deleteProject` IPC call.
 * Worker status is not rendered here — the global application header
 * already shows it.
 */
export default function DashboardSection({ onOpenProject, onProjectDeleted }) {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [libraryOpen, setLibraryOpen] = useState(true);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [pendingPath, setPendingPath] = useState(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [flowError, setFlowError] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [typedName, setTypedName] = useState("");
  const [deletingId, setDeletingId] = useState(null);
  // Same-tick re-entrancy guards: state alone cannot stop two clicks
  // in one frame from opening two dialogs or creating twice.
  const submitBusyRef = useRef(false);
  const deleteBusyRef = useRef(false);

  const deleteBusy = deletingId !== null;
  const nameMatches =
    deleteTarget !== null &&
    typedName.trim().toLocaleLowerCase() === deleteTarget.name.trim().toLocaleLowerCase();

  const refresh = useCallback(async () => {
    if (typeof window.api?.listProjects !== "function") {
      throw bridgeError();
    }
    const res = await window.api.listProjects();
    if (!res || res.ok !== true) {
      throw new Error(res?.error ?? "Could not load projects.");
    }
    return res.projects ?? [];
  }, []);

  useEffect(() => {
    let alive = true;
    refresh()
      .then((list) => {
        if (alive) {
          setProjects(list);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (alive) {
          setError(err?.message ?? "Could not load projects.");
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [refresh]);

  async function handleRetry() {
    setLoading(true);
    setError(null);
    try {
      setProjects(await refresh());
    } catch (err) {
      setError(err?.message ?? "Could not load projects.");
    } finally {
      setLoading(false);
    }
  }

  async function handleAdd() {
    if (submitBusyRef.current || dialogBusy || creating) {
      return;
    }
    submitBusyRef.current = true;
    setDialogBusy(true);
    setFlowError(null);
    try {
      if (typeof window.api?.selectVideo !== "function") {
        throw bridgeError();
      }
      const res = await window.api.selectVideo();
      if (!res) {
        throw new Error("No response from the file dialog.");
      }
      if (res.cancelled) {
        return;
      }
      if (res.ok !== true || !res.path) {
        throw new Error(res.error ?? "Could not select a video.");
      }
      setPendingPath(res.path);
      setName(fileNameOf(res.path).replace(/\.[^.]+$/, ""));
    } catch (err) {
      setFlowError(err?.message ?? "Could not select a video.");
    } finally {
      submitBusyRef.current = false;
      setDialogBusy(false);
    }
  }

  async function handleCreate() {
    if (submitBusyRef.current || creating || !pendingPath) {
      return;
    }
    submitBusyRef.current = true;
    setCreating(true);
    setFlowError(null);
    try {
      if (typeof window.api?.createProject !== "function") {
        throw bridgeError();
      }
      const res = await window.api.createProject(name, pendingPath);
      if (!res || res.ok !== true || !res.project) {
        throw new Error(res?.error ?? "Could not create the project.");
      }
      setPendingPath(null);
      setName("");
      setProjects(await refresh());
      toast.success("Project created", {
        id: "project-created",
        description: res.project.name,
      });
      onOpenProject(res.project.id);
    } catch (err) {
      setFlowError(err?.message ?? "Could not create the project.");
    } finally {
      submitBusyRef.current = false;
      setCreating(false);
    }
  }

  function handleRequestDelete(project) {
    if (deleteBusyRef.current || deletingId !== null) {
      return;
    }
    setDeleteTarget(project);
    setTypedName("");
  }

  function handleCloseDeleteDialog() {
    if (deleteBusyRef.current || deletingId !== null) {
      return;
    }
    setDeleteTarget(null);
    setTypedName("");
  }

  async function handleConfirmDelete(event) {
    event.preventDefault();
    if (deleteBusyRef.current || deletingId !== null) {
      return;
    }
    if (deleteTarget === null || !nameMatches) {
      return;
    }
    deleteBusyRef.current = true;
    setDeletingId(deleteTarget.id);
    try {
      if (typeof window.api?.deleteProject !== "function") {
        throw bridgeError();
      }
      const res = await window.api.deleteProject(deleteTarget.id);
      if (!res || res.ok !== true) {
        throw new Error(res?.error ?? "Could not delete the project.");
      }
      // Deletion succeeded: drop the row immediately so the exit
      // transition plays, then reconcile with the backend list. A
      // refresh failure here must never read as a deletion failure.
      setProjects((prev) => prev.filter((project) => project.id !== deleteTarget.id));
      const deletedName = deleteTarget.name;
      const deletedId = deleteTarget.id;
      setDeleteTarget(null);
      setTypedName("");
      onProjectDeleted?.(deletedId);
      toast.success("Project deleted", {
        id: "project-deleted",
        description: deletedName,
      });
      refresh().then(setProjects, () => {});
    } catch (err) {
      // The dialog stays open with its typed confirmation intact so the
      // user can retry or cancel; the toast carries the failure.
      toast.error("Could not delete project", {
        id: "project-delete-error",
        description: err?.message ?? "Could not delete the project.",
      });
    } finally {
      deleteBusyRef.current = false;
      setDeletingId(null);
    }
  }

  const loaded = !loading && !error;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">
          Dashboard
        </h2>
        <p className="text-xs text-subtle">
          Recorded projects today · live commentary next
        </p>
      </div>

      <LiveCommentaryHero />

      <section
        aria-labelledby="recorded-library-heading"
        className="flex min-w-0 flex-col gap-3"
      >
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={libraryOpen ? "Collapse project library" : "Expand project library"}
            aria-expanded={libraryOpen}
            aria-controls="project-library-body"
            onClick={() => setLibraryOpen((open) => !open)}
          >
            <ChevronDown
              aria-hidden
              className={cn(
                "transition-transform duration-150 motion-reduce:transition-none",
                !libraryOpen && "-rotate-90",
              )}
            />
          </Button>
          <h2
            id="recorded-library-heading"
            className="truncate text-[15px] font-semibold tracking-[-0.01em] text-foreground"
          >
            Recorded gameplay
          </h2>
          {loaded ? (
            <span className="shrink-0 font-mono text-xs tabular-nums text-subtle">
              {projects.length} {projects.length === 1 ? "project" : "projects"}
            </span>
          ) : null}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="default"
              size="sm"
              disabled={dialogBusy || creating || pendingPath !== null}
              onClick={handleAdd}
            >
              {dialogBusy ? (
                <>
                  <Spinner data-icon="inline-start" />
                  Opening…
                </>
              ) : (
                <>
                  <Plus data-icon="inline-start" />
                  Add Video
                </>
              )}
            </Button>
          </div>
        </div>

        <AutoHeight
          deps={[libraryOpen, pendingPath !== null, projects.length, loading, error]}
          transition={{ duration: MOTION.standard, ease: EASING.entrance }}
          className="min-w-0"
        >
          <AnimatePresence mode="wait" initial={false}>
            {!libraryOpen ? null : (
              <motion.div
                key={pendingPath ? "naming" : "library"}
                id="project-library-body"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: MOTION.standard, ease: EASING.entrance }}
              >
                {pendingPath ? (
                  <GlassCard className="flex flex-col gap-3 p-5">
                    <div className="flex flex-col gap-0.5">
                      <h3 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">
                        Name your project
                      </h3>
                      <p className="truncate font-mono text-xs text-subtle">
                        {pendingPath} · .{extensionOf(pendingPath)}
                      </p>
                    </div>
                    <label
                      htmlFor="project-name"
                      className="text-xs font-medium text-muted-foreground"
                    >
                      Project name
                    </label>
                    <input
                      id="project-name"
                      type="text"
                      value={name}
                      maxLength={100}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="Friday finals"
                      className="rounded-md border border-input bg-background px-3 py-2 text-[13px] text-foreground placeholder:text-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        variant="default"
                        disabled={creating || name.trim() === ""}
                        onClick={handleCreate}
                      >
                        {creating ? (
                          <>
                            <Spinner data-icon="inline-start" />
                            Importing…
                          </>
                        ) : (
                          <>
                            <FolderOpen data-icon="inline-start" />
                            Create project
                          </>
                        )}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={creating}
                        onClick={() => {
                          setPendingPath(null);
                          setName("");
                          setFlowError(null);
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      The video is copied into an isolated project folder. The
                      original file is left untouched.
                    </p>
                  </GlassCard>
                ) : loading ? (
                  <ProjectListSkeleton />
                ) : error ? (
                  <div className="flex flex-col items-start gap-3">
                    <Alert variant="destructive">
                      <AlertTitle>Could not load projects</AlertTitle>
                      <AlertDescription>{error}</AlertDescription>
                    </Alert>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleRetry}
                    >
                      <RotateCcw data-icon="inline-start" />
                      Retry
                    </Button>
                  </div>
                ) : projects.length === 0 ? (
                  <GlassCard className="flex flex-col items-center gap-3 p-6 text-center">
                    <span className="flex size-10 items-center justify-center rounded-lg bg-accent text-muted-foreground">
                      <Clapperboard className="size-5" aria-hidden />
                    </span>
                    <h3 className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">
                      No projects yet
                    </h3>
                    <p className="max-w-sm text-[13px] text-muted-foreground">
                      Create a project from a recorded match video. Each project
                      keeps its own source copy and processing output.
                    </p>
                    <Button
                      type="button"
                      variant="default"
                      disabled={dialogBusy}
                      onClick={handleAdd}
                    >
                      <Plus data-icon="inline-start" />
                      Add Video
                    </Button>
                  </GlassCard>
                ) : (
                  <GlassCard className="p-0">
                    <ul className="flex flex-col divide-y divide-border">
                      <AnimatePresence initial={false}>
                        {projects.map((project) => (
                          <ProjectRow
                            key={project.id}
                            project={project}
                            onOpen={onOpenProject}
                            onRequestDelete={handleRequestDelete}
                            deleting={deletingId === project.id}
                            deleteDisabled={deleteBusy}
                          />
                        ))}
                      </AnimatePresence>
                    </ul>
                  </GlassCard>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </AutoHeight>
      </section>

      {flowError ? (
        <Alert variant="destructive">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>{flowError}</AlertDescription>
        </Alert>
      ) : null}

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => {
        if (!open) handleCloseDeleteDialog();
      }}>
        <DialogContent showCloseButton={!deleteBusy} className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-[15px] tracking-tight">Delete project?</DialogTitle>
            <DialogDescription className="text-[13px] leading-relaxed">
              This will permanently delete this project and its associated data. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleConfirmDelete} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <label
                htmlFor="delete-confirm-name"
                className="text-xs font-medium text-muted-foreground"
              >
                Type &ldquo;{deleteTarget?.name}&rdquo; to confirm
              </label>
              <input
                id="delete-confirm-name"
                type="text"
                value={typedName}
                maxLength={100}
                autoComplete="off"
                autoFocus
                disabled={deleteBusy}
                onChange={(event) => setTypedName(event.target.value)}
                placeholder="Enter project name"
                className="rounded-md border border-input bg-background px-3 py-2 text-[13px] text-foreground placeholder:text-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              />
            </div>
            <DialogFooter className="gap-2 sm:flex-row">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={deleteBusy}
                onClick={handleCloseDeleteDialog}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="destructive"
                size="sm"
                disabled={!nameMatches || deleteBusy}
              >
                {deleteBusy ? (
                  <>
                    <Spinner data-icon="inline-start" />
                    Deleting…
                  </>
                ) : (
                  "Delete project"
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
