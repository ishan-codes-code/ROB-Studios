import { useState } from "react";
import { cn } from "cn";

/**
 * Searchable prebuilt-voice picker. Voices come from the backend
 * catalogue; only names and catalogue character labels are shown —
 * no invented personality data.
 */
export default function VoicePicker({ voices, value, onChange, disabled }) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const filtered = needle === ""
    ? voices
    : voices.filter((voice) =>
      `${voice.id} ${voice.character}`.toLowerCase().includes(needle),
    );

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <input
        type="search"
        aria-label="Search voices"
        placeholder="Search 30 voices…"
        autoComplete="off"
        value={query}
        disabled={disabled}
        onChange={(event) => setQuery(event.target.value)}
        className="h-9 rounded-md border border-input bg-background px-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      />
      {filtered.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">
          No voices match “{query.trim()}”.
        </p>
      ) : (
        <div
          role="listbox"
          aria-label="Prebuilt voices"
          className="grid grid-cols-2 gap-1.5 sm:grid-cols-3"
        >
          {filtered.map((voice) => {
            const selected = voice.id === value;
            return (
              <button
                key={voice.id}
                type="button"
                role="option"
                aria-selected={selected}
                disabled={disabled}
                onClick={() => onChange(voice.id)}
                className={cn(
                  "flex min-w-0 flex-col items-start gap-0.5 rounded-md border px-2.5 py-2 text-left transition-colors duration-150",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                  selected
                    ? "border-ring bg-accent"
                    : "border-border bg-background hover:bg-accent/60",
                )}
              >
                <span className="truncate text-[13px] font-medium text-foreground">
                  {voice.id}
                </span>
                <span className="truncate text-[11px] text-muted-foreground">
                  {voice.character || "Studio voice"}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
