import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AutoHeight } from "@animate-ui/react/primitives/effects/auto-height";
import { toast } from "sonner";
import {
  ChevronDown,
  Clapperboard,
  Film,
  MessagesSquare,
  Plus,
  RotateCcw,
  ScanSearch,
  Trash2,
  Upload,
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
import ProjectCreationDialog from "@/components/ProjectCreationDialog.jsx";
import LiveCommentaryHero from "./LiveCommentaryHero.jsx";
import {
  describeArtifacts,
  firstFrameName,
  summarizeDashboard,
} from "@/lib/dashboard-stats.js";
import {
  fileNameOf,
  formatBytes,
  projectMediaUrl,
  timeAgo,
} from "@/lib/format.js";
import { EASING, MOTION } from "@/lib/tokens.js";
import { reportRendererEvent } from "@/lib/diagnostics.js";

const STATUS_BADGE = {
  idle: "outline",
  processing: "default",
  done: "secondary",
  error: "destructive",
  cancelled: "outline",
  interrupted: "outline",
};

// The dashboard overview stays compact no matter how large the
// library grows: the first page of recent projects renders inline,
// the rest on demand through the View All toggle below the grid.
const RECENT_PROJECT_LIMIT = 6;

function bridgeError() {
  return new Error("Worker bridge unavailable (running outside Electron?).");
}

function StatCard({ icon: Icon, label, value, detail, ready }) {
  return (
    <li className="min-w-0">
      <GlassCard className="flex items-center gap-3 p-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent text-muted-foreground">
          <Icon className="size-4" aria-hidden />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-xs font-medium text-muted-foreground">{label}</span>
          {ready ? (
            <span className="font-mono text-xl font-semibold tabular-nums leading-none text-foreground">
              {value}
            </span>
          ) : (
            <Skeleton className="h-5 w-8 motion-reduce:animate-none" />
          )}
          <span className="truncate text-xs text-subtle">{detail}</span>
        </span>
      </GlassCard>
    </li>
  );
}

function ProjectCard({ project, listing, current, onOpen, onRequestDelete, deleting, deleteDisabled }) {
  const [thumbFailed, setThumbFailed] = useState(false);
  const frame = firstFrameName(listing);
  const thumbUrl = !thumbFailed && frame !== null
    ? projectMediaUrl(project.id, "frames", frame)
    : null;
  const chips = useMemo(() => describeArtifacts(listing), [listing]);

  return (
    <motion.li
      initial={false}
      exit={{ opacity: 0, x: 12 }}
      transition={{ duration: MOTION.fast, ease: EASING.entrance }}
      className="min-w-0"
    >
      <GlassCard className="flex h-full flex-col overflow-hidden p-0 transition-colors duration-150 hover:border-input">
        <button
          type="button"
          onClick={() => onOpen(project.id)}
          aria-label={`Open ${project.name}`}
          className="relative block aspect-video w-full overflow-hidden bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          {thumbUrl !== null ? (
            <img
              src={thumbUrl}
              alt=""
              aria-hidden
              draggable={false}
              loading="lazy"
              decoding="async"
              onError={() => setThumbFailed(true)}
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="flex h-full w-full items-center justify-center">
              <Film className="size-6 text-subtle" aria-hidden />
            </span>
          )}
          <span className="absolute left-2 top-2">
            <Badge variant={STATUS_BADGE[project.processingStatus] ?? "outline"} className="bg-background/70">
              {project.processingStatus}
            </Badge>
          </span>
          {current ? (
            <span className="absolute right-2 top-2">
              <Badge variant="secondary" className="bg-background/70">Current</Badge>
            </span>
          ) : null}
        </button>
        <div className="flex min-w-0 flex-1 flex-col gap-1 p-3">
          <div className="flex min-w-0 items-start gap-2">
            <button
              type="button"
              onClick={() => onOpen(project.id)}
              className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="truncate text-[13px] font-semibold text-foreground">
                {project.name}
              </span>
              <span className="truncate font-mono text-xs text-subtle">
                {fileNameOf(project.sourceVideo.path)} ·{" "}
                {formatBytes(project.sourceVideo.sizeBytes)}
              </span>
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
          </div>
          <div className="mt-auto flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pt-1">
            <span className="shrink-0 text-xs text-subtle">
              opened {timeAgo(project.lastOpenedAt)}
            </span>
            {chips.map((chip) => (
              <span
                key={chip.key}
                className="shrink-0 rounded-full border border-border px-1.5 py-px text-[11px] text-muted-foreground"
              >
                {chip.label}
              </span>
            ))}
          </div>
        </div>
      </GlassCard>
    </motion.li>
  );
}

function QuickAction({ icon: Icon, title, text, onClick }) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="flex w-full items-start gap-2.5 rounded-md p-2 text-left transition-colors duration-150 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-accent text-muted-foreground">
          <Icon className="size-4" aria-hidden />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[13px] font-medium text-foreground">{title}</span>
          <span className="text-xs leading-relaxed text-muted-foreground">{text}</span>
        </span>
      </button>
    </li>
  );
}

function ProjectGridSkeleton() {
  return (
    <div
      className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
      role="status" aria-label="Loading projects"
    >
      <span className="sr-only">Loading projects…</span>
      {[0, 1, 2].map((index) => (
        <GlassCard key={index} aria-hidden className="flex flex-col gap-3 p-3">
          <Skeleton className="aspect-video w-full motion-reduce:animate-none" />
          <Skeleton className="h-4 w-2/3 motion-reduce:animate-none" />
          <Skeleton className="h-3 w-1/2 motion-reduce:animate-none" />
        </GlassCard>
      ))}
    </div>
  );
}

/**
 * Product-first dashboard: a workspace greeting, the cinematic
 * live-commentary banner, honest counts from persisted data, the
 * recent-projects library as media cards, and quick actions into the
 * existing workflows. The library shows the first page of recent
 * projects inline with the rest on demand, so the overview stays
 * compact at any project count. Project IPC semantics are unchanged
 * (native picker → name → isolated copy → open workspace; typed-name
 * deletion). Worker status is not rendered here — the global
 * application header already shows it.
 */
export default function DashboardSection({ onOpenProject, onProjectDeleted, activeProjectId = null }) {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [listings, setListings] = useState({});
  const [listingsLoaded, setListingsLoaded] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(true);
  const [libraryExpanded, setLibraryExpanded] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [typedName, setTypedName] = useState("");
  const [deletingId, setDeletingId] = useState(null);
  // Same-tick re-entrancy guard: state alone cannot stop two clicks in
  // one frame from deleting twice. Creation single-flights inside its
  // dialog.
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

  // Mount milestones for crash forensics: if the renderer dies on
  // the way to the dashboard, the diagnostics log shows how far the
  // mount and hydration got. Counts only — never project content.
  useEffect(() => {
    reportRendererEvent("dashboard.mount.started", {});
    const frame = requestAnimationFrame(() => {
      reportRendererEvent("dashboard.mount.completed", {});
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    let alive = true;
    reportRendererEvent("dashboard.hydration.started", {});
    refresh()
      .then((list) => {
        reportRendererEvent("dashboard.hydration.completed", { ok: true, projectCount: list.length });
        if (alive) {
          setProjects(list);
          setLoading(false);
        }
      })
      .catch((err) => {
        reportRendererEvent("dashboard.hydration.completed", { ok: false });
        if (alive) {
          setError(err?.message ?? "Could not load projects.");
          setLoading(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [refresh]);

  // One artifact-listing pass per project list, feeding both the
  // statistics row and the card thumbnails/chips. Failed listings stay
  // null and simply contribute nothing — never a fabricated zero.
  const projectIds = useMemo(
    () => projects.map((project) => project.id),
    [projects],
  );

  useEffect(() => {
    if (loading || error || projectIds.length === 0) {
      setListings({});
      setListingsLoaded(!loading && !error);
      return undefined;
    }
    let alive = true;
    setListingsLoaded(false);
    (async () => {
      const settled = await Promise.all(
        projectIds.map(async (id) => {
          try {
            if (typeof window.api?.listArtifacts !== "function") {
              return [id, null];
            }
            const res = await window.api.listArtifacts(id);
            if (res?.ok === true && res.artifacts && typeof res.artifacts === "object") {
              return [id, res.artifacts];
            }
          } catch {
            // Missing or unreadable artifacts: the card falls back to
            // its thumbnail placeholder and no chips.
          }
          return [id, null];
        }),
      );
      if (alive) {
        setListings(Object.fromEntries(settled));
        setListingsLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [projectIds, loading, error]);

  const stats = useMemo(() => summarizeDashboard(projects, listings), [projects, listings]);
  // listProjects sorts by last opened first, so the head is the
  // natural target when an action needs an existing project.
  const latestProjectId = projects.length > 0 ? projects[0].id : null;
  const visibleProjects = libraryExpanded
    ? projects
    : projects.slice(0, RECENT_PROJECT_LIMIT);
  const hasMoreProjects = projects.length > RECENT_PROJECT_LIMIT;

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

  function handleAdd() {
    setCreateOpen(true);
  }

  async function handleCreated(projectId) {
    // Keep project creation success in the dashboard owner so toast
    // responsibility stays in one place and the library refresh is
    // still atomic with the open action. A refresh failure here must
    // never read as a creation failure.
    try {
      setProjects(await refresh());
    } catch {
      // The project exists; the next mount reloads the list.
    }
    toast.success("Project created", {
      id: "project-created",
      description: projects.find((entry) => entry.id === projectId)?.name ?? "Project created",
    });
    onOpenProject(projectId);
  }

  // Quick actions reuse the existing workflows: the editor owns runs
  // and commentary, so both open the latest project there. Without a
  // project they fall back to the import dialog instead of faking it.
  function handleRunAnalysis() {
    if (latestProjectId !== null) {
      onOpenProject(latestProjectId);
    } else {
      setCreateOpen(true);
    }
  }

  function handleGenerateCommentary() {
    if (latestProjectId !== null) {
      onOpenProject(latestProjectId);
    } else {
      setCreateOpen(true);
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
      // Deletion succeeded: drop the card immediately so the exit
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
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 pb-8">
      <div className="min-w-0">
        <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-foreground">
          Welcome back
        </h2>
        <p className="mt-0.5 text-[13px] text-muted-foreground">
          ROB, your evidence-aware live commentary companion.
        </p>
      </div>

      <LiveCommentaryHero />

      <section aria-label="Workspace statistics" className="min-w-0">
        <ul className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3">
          <StatCard
            icon={Clapperboard}
            label="Projects"
            value={stats.projects}
            detail="recorded projects"
            ready={loaded}
          />
          <StatCard
            icon={ScanSearch}
            label="Analyses"
            value={stats.analyses}
            detail="projects with analysis output"
            ready={loaded && listingsLoaded}
          />
          <StatCard
            icon={MessagesSquare}
            label="Commentaries"
            value={stats.commentaries}
            detail="projects with commentary output"
            ready={loaded && listingsLoaded}
          />
        </ul>
      </section>

      <div className="grid min-w-0 grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_264px]">
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
              Recent projects
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
                onClick={handleAdd}
              >
                <Plus data-icon="inline-start" />
                New project
              </Button>
            </div>
          </div>

          <AutoHeight
            deps={[libraryOpen, libraryExpanded, projects.length, loading, error]}
            transition={{ duration: MOTION.standard, ease: EASING.entrance }}
            className="min-w-0"
          >
            <AnimatePresence mode="wait" initial={false}>
              {!libraryOpen ? null : (
                <motion.div
                  key="library"
                  id="project-library-body"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: MOTION.standard, ease: EASING.entrance }}
                >
                  {loading ? (
                    <ProjectGridSkeleton />
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
                        onClick={handleAdd}
                      >
                        <Plus data-icon="inline-start" />
                        New project
                      </Button>
                    </GlassCard>
                  ) : (
                    <>
                      <ul className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                        <AnimatePresence initial={false}>
                          {visibleProjects.map((project) => (
                            <ProjectCard
                              key={project.id}
                              project={project}
                              listing={listings[project.id] ?? null}
                              current={project.id === activeProjectId}
                              onOpen={onOpenProject}
                              onRequestDelete={handleRequestDelete}
                              deleting={deletingId === project.id}
                              deleteDisabled={deleteBusy}
                            />
                          ))}
                        </AnimatePresence>
                      </ul>
                      {hasMoreProjects ? (
                        <div className="mt-3 flex justify-center">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            aria-expanded={libraryExpanded}
                            aria-controls="project-library-body"
                            onClick={() => setLibraryExpanded((value) => !value)}
                          >
                            {libraryExpanded
                              ? "Show less"
                              : `View all ${projects.length} projects`}
                          </Button>
                        </div>
                      ) : null}
                    </>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </AutoHeight>
        </section>

        <aside aria-label="Quick actions" className="min-w-0">
          <GlassCard className="flex flex-col gap-2 p-3">
            <h2 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">
              Quick actions
            </h2>
            <Button
              type="button"
              variant="default"
              onClick={handleAdd}
              className="w-full"
            >
              <Upload data-icon="inline-start" />
              Import gameplay
            </Button>
            <ul className="flex min-w-0 flex-col">
              <QuickAction
                icon={ScanSearch}
                title="Run AI analysis"
                text={
                  latestProjectId !== null
                    ? "Open the latest project to start a run."
                    : "Import a project first, then start a run."
                }
                onClick={handleRunAnalysis}
              />
              <QuickAction
                icon={MessagesSquare}
                title="Generate commentary"
                text={
                  latestProjectId !== null
                    ? "Open the latest project for script and voice."
                    : "Import a project first, then generate."
                }
                onClick={handleGenerateCommentary}
              />
            </ul>
          </GlassCard>
        </aside>
      </div>

      <ProjectCreationDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={handleCreated}
      />

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
