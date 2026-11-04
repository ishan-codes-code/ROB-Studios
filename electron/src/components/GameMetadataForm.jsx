import { useState } from "react";
import { Badge } from "@/components/ui/badge.jsx";

export const GAME_ID = "free-fire";
export const GAME_NAME = "Free Fire";
export const GAME_LANGUAGE_DEFAULT = "English";

const inputClassName =
  "h-9 rounded-md border border-input bg-background px-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";

/** Blank form state. The game id is fixed: Free Fire is the only supported game. */
export function createEmptyGameInput() {
  return {
    id: GAME_ID,
    mode: "",
    matchType: "",
    map: "",
    language: GAME_LANGUAGE_DEFAULT,
    teams: "",
    additionalContext: "",
  };
}

/** Form state for an existing project-owned game record. */
export function gameRecordToInput(game) {
  return {
    id: GAME_ID,
    mode: game?.mode ?? "",
    matchType: game?.matchType ?? "",
    map: game?.map ?? "",
    language: game?.language ?? GAME_LANGUAGE_DEFAULT,
    teams: Array.isArray(game?.teams) ? game.teams.join(", ") : "",
    additionalContext: game?.additionalContext ?? "",
  };
}

/** Form state back to the validated project shape (teams split, blanks nulled). */
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
    id: GAME_ID,
    mode: text(input.mode),
    matchType: text(input.matchType),
    map: text(input.map),
    language: text(input.language) ?? GAME_LANGUAGE_DEFAULT,
    teams,
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

/**
 * Project-owned game metadata form. Shared by project creation
 * (Dashboard) and the editor Configure tab. Game is fixed to Free
 * Fire — the only supported title — shown honestly as a badge rather
 * than a fake dropdown; everything else is optional match context.
 */
export default function GameMetadataForm({ initial, disabled = false, onChange }) {
  const [input, setInput] = useState(() => initial ?? createEmptyGameInput());

  const update = (patch) => {
    setInput((current) => {
      const next = { ...current, ...patch };
      onChange?.(gameInputToRecord(next));
      return next;
    });
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-[13px] font-medium text-foreground">Game</span>
        <Badge variant="secondary">{GAME_NAME}</Badge>
        <span className="text-[12px] text-muted-foreground">Only supported game for now</span>
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-3 min-[420px]:grid-cols-3">
        <Field label="Game mode">
          <input
            className={`${inputClassName} min-w-0 w-full`}
            value={input.mode}
            maxLength={80}
            placeholder="Battle royale"
            disabled={disabled}
            onChange={(event) => update({ mode: event.target.value })}
          />
        </Field>
        <Field label="Match type">
          <input
            className={`${inputClassName} min-w-0 w-full`}
            value={input.matchType}
            maxLength={80}
            placeholder="Ranked"
            disabled={disabled}
            onChange={(event) => update({ matchType: event.target.value })}
          />
        </Field>
        <Field label="Map">
          <input
            className={`${inputClassName} min-w-0 w-full`}
            value={input.map}
            maxLength={80}
            placeholder="Bermuda"
            disabled={disabled}
            onChange={(event) => update({ map: event.target.value })}
          />
        </Field>
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-3 min-[420px]:grid-cols-2">
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
          placeholder="Tournament semifinal, custom room…"
          disabled={disabled}
          onChange={(event) => update({ additionalContext: event.target.value })}
        />
      </Field>
    </div>
  );
}
