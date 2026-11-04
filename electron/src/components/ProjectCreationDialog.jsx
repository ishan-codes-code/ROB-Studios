import { useEffect, useRef, useState } from "react";
import { Clapperboard, FolderOpen, X } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.jsx";
import { Button } from "@/components/ui/button.jsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.jsx";
import { Spinner } from "@/components/ui/spinner.jsx";
import FileUpload from "@/components/kokonutui/file-upload.jsx";
import GameMetadataForm from "@/components/GameMetadataForm.jsx";
import { fileNameOf, formatBytes } from "@/lib/format.js";

// Renderer mirror of the main-process supported video list
// (worker-protocol's set is node-only). The main process revalidates
// every import; a test asserts both lists stay identical.
export const SUPPORTED_VIDEO_EXTENSIONS = [".mp4", ".avi", ".mov", ".mkv", ".webm"];

function stripExtension(name) {
  return name.replace(/\.[^.]+$/, "");
}

/**
 * Dedicated project creation dialog: name, one gameplay recording
 * (drag-and-drop or system file picker), game, and match details.
 * The recording path flows into the existing create-project IPC, so
 * import/copy stays in the main process; a failed import keeps the
 * dialog open with an inline error and never creates the project.
 */
export default function ProjectCreationDialog({ open, onOpenChange, onCreated }) {
  const [name, setName] = useState("");
  const [recording, setRecording] = useState(null);
  const [game, setGame] = useState(null);
  const [creating, setCreating] = useState(false);
  const [browseBusy, setBrowseBusy] = useState(false);
  const [error, setError] = useState("");
  const busyRef = useRef(false);

  useEffect(() => {
    if (open) {
      setName("");
      setRecording(null);
      setGame(null);
      setCreating(false);
      setBrowseBusy(false);
      setError("");
      busyRef.current = false;
    }
  }, [open ]);

  const defaultNameFrom = (fileName) => {
    setName((current) => (current.trim() === "" ? stripExtension(fileNameOf(fileName)) : current));
  };

  // Renderer Files no longer carry .path (removed in Electron 32):
  // the preload bridge resolves it; only the path crosses IPC —
  // bytes are never read here.
  const resolveRecordingPath = (file) => {
    if (typeof file?.path === "string" && file.path !== "") {
      return file.path;
    }
    if (typeof window.api?.getPathForFile === "function") {
      try {
        const bridged = window.api.getPathForFile(file);
        if (typeof bridged === "string" && bridged !== "") {
          return bridged;
        }
      } catch {
        // Fall through to the actionable error below.
      }
    }
    return "";
  };

  const acceptRecording = async (file) => {
    if (resolveRecordingPath(file) === "") {
      throw new Error("Couldn't read this file's path. Use Browse instead.");
    }
  };

  const handleDropSuccess = (file) => {
    setRecording({ path: resolveRecordingPath(file), name: file.name, size: file.size });
    defaultNameFrom(file.name);
  };

  const clearRecording = () => setRecording(null);

  async function handleBrowse() {
    if (busyRef.current || browseBusy || creating) {
      return;
    }
    busyRef.current = true;
    setBrowseBusy(true);
    setError("");
    try {
      if (typeof window.api?.selectVideo !== "function") {
        throw new Error("Worker bridge unavailable (running outside Electron?).");
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
      setRecording({ path: res.path, name: fileNameOf(res.path), size: null });
      defaultNameFrom(res.path);
    } catch (err) {
      setError(err?.message ?? "Could not select a video.");
    } finally {
      busyRef.current = false;
      setBrowseBusy(false);
    }
  }

  async function handleCreate() {
    if (busyRef.current || creating) {
      return;
    }
    const trimmed = name.trim();
    if (trimmed === "" || !recording) {
      return;
    }
    busyRef.current = true;
    setCreating(true);
    setError("");
    try {
      if (typeof window.api?.createProject !== "function") {
        throw new Error("Worker bridge unavailable (running outside Electron?).");
      }
      const res = await window.api.createProject(trimmed, recording.path, game);
      if (!res || res.ok !== true || !res.project) {
        throw new Error(res?.error ?? "Could not create the project.");
      }
      toast.success("Project created", {
        id: "project-created",
        description: res.project.name,
      });
      onOpenChange(false);
      onCreated?.(res.project.id);
    } catch (err) {
      // Import failures keep the dialog open: nothing was created, and
      // the user's entries stay intact for a retry.
      setError(err?.message ?? "Could not create the project.");
    } finally {
      busyRef.current = false;
      setCreating(false);
    }
  }

  const canCreate = name.trim() !== "" && recording !== null && !creating;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Never dismiss mid-import: the project either exists with its
        // recording or nothing was created at all.
        if (!creating) {
          onOpenChange(next);
        }
      }}
    >
      <DialogContent className="flex max-h-[88vh] flex-col overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Name the project, attach its gameplay recording, then describe the match.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-5 overflow-y-auto px-0.5 pb-1">
          <label className="flex min-w-0 flex-col gap-1.5 text-[13px]">
            <span className="font-medium text-foreground">Project name</span>
            <input
              type="text"
              value={name}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
              placeholder="Friday finals"
              disabled={creating}
              className="rounded-md border border-input bg-background px-3 py-2 text-[13px] text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            />
          </label>

          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-[13px] font-medium text-foreground">Gameplay recording</span>
            {recording ? (
              <div className="flex min-w-0 items-center gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
                <span
                  aria-hidden="true"
                  className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted"
                >
                  <Clapperboard className="size-4 text-muted-foreground" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-foreground" title={recording.name}>
                    {recording.name}
                  </p>
                  <p className="truncate font-mono text-[11px] tabular-nums text-muted-foreground" title={recording.path}>
                    {typeof recording.size === "number" ? `${formatBytes(recording.size)} · ` : ""}
                    One recording per project
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={creating}
                  onClick={clearRecording}
                  title="Remove recording"
                  aria-label="Remove recording"
                >
                  <X data-icon="inline-start" />
                  Remove
                </Button>
              </div>
            ) : (
              <>
                <FileUpload
                  multiple={false}
                  maxFiles={1}
                  acceptedFileTypes={SUPPORTED_VIDEO_EXTENSIONS}
                  maxFileSize={Number.POSITIVE_INFINITY}
                  onUpload={acceptRecording}
                  onUploadSuccess={handleDropSuccess}
                  onFileRemove={clearRecording}
                  className="mx-0 max-w-none"
                />
                <div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={browseBusy || creating}
                    onClick={handleBrowse}
                  >
                    {browseBusy ? (
                      <>
                        <Spinner data-icon="inline-start" />
                        Opening…
                      </>
                    ) : (
                      <>
                        <FolderOpen data-icon="inline-start" />
                        or browse files…
                      </>
                    )}
                  </Button>
                </div>
              </>
            )}
          </div>

          <GameMetadataForm disabled={creating} onChange={setGame} />

          {error ? (
            <Alert variant="destructive">
              <AlertTitle>Could not create the project</AlertTitle>
              <AlertDescription className="min-w-0 [overflow-wrap:anywhere]">
                {error}
              </AlertDescription>
            </Alert>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={creating}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="default"
            disabled={!canCreate}
            onClick={handleCreate}
          >
            {creating ? (
              <>
                <Spinner data-icon="inline-start" />
                Importing…
              </>
            ) : (
              "Create project"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
