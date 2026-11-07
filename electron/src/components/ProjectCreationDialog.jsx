import { useEffect, useId, useRef, useState } from "react";
import { Plus } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.jsx";
import { Spinner } from "@/components/ui/spinner.jsx";
import { gameInputToRecord } from "@/components/GameMetadataForm.jsx";
import { DEFAULT_GAME_ID, GAMES, mapsFor, matchTypesFor, modesFor } from "@/lib/games.js";
import { fileNameOf } from "@/lib/format.js";

const inputClassName =
  "h-9 rounded-md border border-input bg-background px-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const triggerClassName = "w-full min-w-0 bg-background text-[13px] dark:bg-background";

function Field({ label, children }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-[13px]">
      <span className="font-medium text-foreground">{label}</span>
      {children}
    </label>
  );
}

/**
 * Minimal project creation dialog: name, game, a few optional match
 * details, and one gameplay video through the native picker. Import
 * stays in the main process via the existing create-project IPC; a
 * failed import keeps the dialog open and never creates the project.
 * Full match details (category, tournament, teams, notes) live in
 * the editor Configure tab, which owns the shared metadata form.
 */
export default function ProjectCreationDialog({ open, onOpenChange, onCreated }) {
  const [name, setName] = useState("");
  const [gameId, setGameId] = useState(DEFAULT_GAME_ID);
  const [matchType, setMatchType] = useState("");
  const [mode, setMode] = useState("");
  const [map, setMap] = useState("");
  const [recording, setRecording] = useState(null);
  const [creating, setCreating] = useState(false);
  const [browseBusy, setBrowseBusy] = useState(false);
  const [error, setError] = useState("");
  const busyRef = useRef(false);
  const mapListId = useId();

  useEffect(() => {
    if (open) {
      setName("");
      setGameId(DEFAULT_GAME_ID);
      setMatchType("");
      setMode("");
      setMap("");
      setRecording(null);
      setCreating(false);
      setBrowseBusy(false);
      setError("");
      busyRef.current = false;
    }
  }, [open]);

  const modes = modesFor(gameId, matchType || null);
  const maps = mapsFor(gameId);

  const selectGame = (next) => {
    if (next === gameId) return;
    // Match type/mode option sets differ per game.
    setGameId(next);
    setMatchType("");
    setMode("");
  };

  const selectMatchType = (next) => {
    // A new match type can invalidate the mode (e.g. Clash Squad
    // has none): drop modes the new type forbids.
    const allowed = modesFor(gameId, next || null);
    setMatchType(next);
    setMode(allowed === null || (mode !== "" && !allowed.includes(mode)) ? "" : mode);
  };

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
      setRecording({ path: res.path, name: fileNameOf(res.path) });
      setName((current) => (
        current.trim() === "" ? fileNameOf(res.path).replace(/\.[^.]+$/, "") : current
      ));
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
      const game = gameInputToRecord({
        gameId,
        matchType,
        mode,
        map,
        category: "",
        teams: "",
        tournament: "",
        stage: "",
        language: "English",
        additionalContext: "",
      });
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
      <DialogContent className="flex max-h-[88vh] flex-col overflow-hidden sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            Name the project, pick its game, and attach the gameplay video.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto px-0.5 pb-1">
          <Field label="Project name">
            <input
              type="text"
              value={name}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
              placeholder="Friday finals"
              disabled={creating}
              className={`${inputClassName} w-full`}
            />
          </Field>

          <div className="grid min-w-0 grid-cols-2 gap-3">
            <Field label="Game">
              <Select value={gameId} disabled={creating} onValueChange={selectGame}>
                <SelectTrigger aria-label="Game" className={triggerClassName}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GAMES.map((game) => (
                    <SelectItem key={game.id} value={game.id}>{game.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Match type">
              <Select
                value={matchType}
                disabled={creating}
                onValueChange={selectMatchType}
              >
                <SelectTrigger aria-label="Match type" className={triggerClassName}>
                  <SelectValue placeholder="Optional" />
                </SelectTrigger>
                <SelectContent>
                  {matchTypesFor(gameId).map((option) => (
                    <SelectItem key={option} value={option}>{option}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <div className="grid min-w-0 grid-cols-2 gap-3">
            {modes !== null ? (
              <Field label="Mode">
                <Select value={mode} disabled={creating} onValueChange={setMode}>
                  <SelectTrigger aria-label="Mode" className={triggerClassName}>
                    <SelectValue placeholder="Optional" />
                  </SelectTrigger>
                  <SelectContent>
                    {modes.map((option) => (
                      <SelectItem key={option} value={option}>{option}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : null}
            <Field label="Map">
              <input
                className={`${inputClassName} min-w-0 w-full`}
                value={map}
                maxLength={80}
                placeholder={maps[0] ?? "Optional"}
                list={maps.length > 0 ? mapListId : undefined}
                disabled={creating}
                onChange={(event) => setMap(event.target.value)}
              />
              {maps.length > 0 ? (
                <datalist id={mapListId}>
                  {maps.map((entry) => (
                    <option key={entry} value={entry} />
                  ))}
                </datalist>
              ) : null}
            </Field>
          </div>

          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-[13px] font-medium text-foreground">Gameplay video</span>
            {recording ? (
              <div className="flex min-w-0 items-center gap-2">
                <p className="min-w-0 flex-1 truncate text-[13px] text-foreground" title={recording.path}>
                  {recording.name}
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={browseBusy || creating}
                  onClick={handleBrowse}
                >
                  Replace
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={creating}
                  onClick={() => setRecording(null)}
                >
                  Remove
                </Button>
              </div>
            ) : (
              <div>
                <Button
                  type="button"
                  variant="outline"
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
                      <Plus data-icon="inline-start" />
                      Add video
                    </>
                  )}
                </Button>
              </div>
            )}
          </div>

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
