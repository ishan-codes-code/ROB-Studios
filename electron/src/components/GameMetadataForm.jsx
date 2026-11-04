import { useId, useState } from "react";
import { cn } from "cn";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.jsx";
import {
  GAMES,
  categoriesFor,
  mapsFor,
  matchTypesFor,
  modesFor,
} from "@/lib/games.js";

export const GAME_LANGUAGE_DEFAULT = "English";

const inputClassName =
  "h-9 rounded-md border border-input bg-background px-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

/** Blank form state (Free Fire default). */
export function createEmptyGameInput() {
  return {
    gameId: "free-fire",
    matchType: "",
    mode: "",
    map: "",
    category: "",
    teams: "",
    tournament: "",
    stage: "",
    language: GAME_LANGUAGE_DEFAULT,
    additionalContext: "",
  };
}

/** Form state for an existing project-owned game record. */
export function gameRecordToInput(game) {
  return {
    gameId: game?.id ?? "free-fire",
    matchType: game?.matchType ?? "",
    mode: game?.mode ?? "",
    map: game?.map ?? "",
    category: game?.category ?? "",
    teams: Array.isArray(game?.teams) ? game.teams.join(", ") : "",
    tournament: game?.tournament ?? "",
    stage: game?.stage ?? "",
    language: game?.language ?? GAME_LANGUAGE_DEFAULT,
    additionalContext: game?.additionalContext ?? "",
  };
}

/** Form state back to the validated project shape (blanks nulled). */
export function gameInputToRecord(input) {
  const text = (value) => {
    const trimmed = (value ?? "").trim();
    return trimmed === "" ? null : trimmed;
  };
  const teams = (input.teams ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .slice(0, 8);
  return {
    id: input.gameId,
    matchType: text(input.matchType),
    mode: text(input.mode),
    map: text(input.map),
    category: text(input.category),
    teams,
    tournament: text(input.tournament),
    stage: text(input.stage),
    language: text(input.language) ?? GAME_LANGUAGE_DEFAULT,
    additionalContext: (input.additionalContext ?? "").trim(),
  };
}

function Field({ label, hint, children }) {
  return (
    <label className="flex min-w-0 flex-col gap-1.5 text-[13px]">
      <span className="font-medium text-foreground">{label}</span>
      {children}
      {hint ? <span className="text-[12px] text-muted-foreground">{hint}</span> : null}
    </label>
  );
}

// Radix has no empty option, so clearing maps through an internal
// sentinel; callers keep the "" contract.
const CLEAR_VALUE = "__clear__";

/**
 * Suggestion select: per-game options plus the current value when it
 * is a legacy/custom entry, so stored values never render blank and
 * are never silently dropped. Built on the shared Select primitive.
 */
function SuggestSelect({ value, options, placeholder, disabled, onSelect, ariaLabel }) {
  const known = options.includes(value);
  return (
    <Select
      value={value}
      disabled={disabled}
      onValueChange={(next) => onSelect(next === CLEAR_VALUE ? "" : next)}
    >
      <SelectTrigger aria-label={ariaLabel} className="w-full min-w-0 bg-background text-[13px] dark:bg-background">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={CLEAR_VALUE}>None</SelectItem>
        {options.map((option) => (
          <SelectItem key={option} value={option}>{option}</SelectItem>
        ))}
        {!known && value !== "" ? (
          <SelectItem value={value}>{value}</SelectItem>
        ) : null}
      </SelectContent>
    </Select>
  );
}

/**
 * Project-owned game metadata form. Shared by project creation and
 * the editor Configure tab. The game switcher drives per-game match
 * fields; switching games resets match type/mode (their option sets
 * differ) but keeps language, teams, tournament, stage, and notes.
 */
export default function GameMetadataForm({ initial, disabled = false, onChange }) {
  const [input, setInput] = useState(() => initial ?? createEmptyGameInput());
  const mapListId = useId();

  const update = (patch) => {
    setInput((current) => {
      const next = { ...current, ...patch };
      onChange?.(gameInputToRecord(next));
      return next;
    });
  };

  const selectGame = (gameId) => {
    if (gameId === input.gameId) return;
    update({ gameId, matchType: "", mode: "" });
  };

  const modes = modesFor(input.gameId, input.matchType || null);
  const maps = mapsFor(input.gameId);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-col gap-2" role="group" aria-label="Game">
        <span className="text-[13px] font-medium text-foreground">Game</span>
        <div className="grid min-w-0 grid-cols-3 gap-2">
          {GAMES.map((game) => {
            const active = game.id === input.gameId;
            return (
              <button
                key={game.id}
                type="button"
                aria-pressed={active}
                disabled={disabled}
                onClick={() => selectGame(game.id)}
                title={game.name}
                className={cn(
                  "min-w-0 truncate rounded-md border px-2 py-2 text-[12px] font-medium outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                  active
                    ? "border-foreground/40 bg-muted text-foreground"
                    : "border-input bg-background text-muted-foreground hover:text-foreground",
                )}
              >
                {game.shortName}
              </button>
            );
          })}
        </div>
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-4 min-[420px]:grid-cols-3">
        <Field label="Match type">
          <SuggestSelect
            ariaLabel="Match type"
            value={input.matchType}
            options={matchTypesFor(input.gameId)}
            placeholder="Select…"
            disabled={disabled}
            onSelect={(matchType) => {
              // A new match type can invalidate the mode (e.g. Clash
              // Squad has none): drop modes the new type forbids.
              const allowed = modesFor(input.gameId, matchType || null);
              update({
                matchType,
                mode: allowed === null || (input.mode !== "" && !allowed.includes(input.mode)) ? "" : input.mode,
              });
            }}
          />
        </Field>
        {modes !== null ? (
          <Field label="Mode">
            <SuggestSelect
              ariaLabel="Mode"
              value={input.mode}
              options={modes}
              placeholder="Select…"
              disabled={disabled}
              onSelect={(mode) => update({ mode })}
            />
          </Field>
        ) : null}
        <Field label="Map">
          <input
            className={`${inputClassName} min-w-0 w-full`}
            value={input.map}
            maxLength={80}
            placeholder={maps[0] ?? "Map name"}
            list={maps.length > 0 ? mapListId : undefined}
            disabled={disabled}
            onChange={(event) => update({ map: event.target.value })}
          />
          {maps.length > 0 ? (
            <datalist id={mapListId}>
              {maps.map((map) => (
                <option key={map} value={map} />
              ))}
            </datalist>
          ) : null}
        </Field>
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-4 min-[420px]:grid-cols-3">
        <Field label="Category">
          <SuggestSelect
            ariaLabel="Category"
            value={input.category}
            options={categoriesFor(input.gameId)}
            placeholder="Select…"
            disabled={disabled}
            onSelect={(category) => update({ category })}
          />
        </Field>
        <Field label="Tournament">
          <input
            className={`${inputClassName} min-w-0 w-full`}
            value={input.tournament}
            maxLength={80}
            placeholder="Optional"
            disabled={disabled}
            onChange={(event) => update({ tournament: event.target.value })}
          />
        </Field>
        <Field label="Stage / round">
          <input
            className={`${inputClassName} min-w-0 w-full`}
            value={input.stage}
            maxLength={80}
            placeholder="Optional"
            disabled={disabled}
            onChange={(event) => update({ stage: event.target.value })}
          />
        </Field>
      </div>

      <div className="grid min-w-0 grid-cols-1 gap-4 min-[420px]:grid-cols-2">
        <Field label="Language" hint="Commentary language.">
          <input
            className={`${inputClassName} min-w-0 w-full`}
            value={input.language}
            maxLength={80}
            placeholder={GAME_LANGUAGE_DEFAULT}
            disabled={disabled}
            onChange={(event) => update({ language: event.target.value })}
          />
        </Field>
        <Field label="Teams / players" hint="Comma-separated.">
          <input
            className={`${inputClassName} min-w-0 w-full`}
            value={input.teams}
            maxLength={400}
            placeholder="Team A, Team B"
            disabled={disabled}
            onChange={(event) => update({ teams: event.target.value })}
          />
        </Field>
      </div>

      <Field label="Additional match context" hint="Anything else the commentary should know.">
        <textarea
          className="min-h-16 w-full min-w-0 rounded-md border border-input bg-background px-3 py-2 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          value={input.additionalContext}
          maxLength={2000}
          rows={2}
          placeholder="Semifinal, custom room…"
          disabled={disabled}
          onChange={(event) => update({ additionalContext: event.target.value })}
        />
      </Field>
    </div>
  );
}
