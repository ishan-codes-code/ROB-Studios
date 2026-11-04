import {
  AudioWaveform,
  Clapperboard,
  KeyRound,
  LayoutDashboard,
  MessagesSquare,
  Mic,
  ScanSearch,
  ScrollText,
  Settings,
} from "lucide-react";
import { cn } from "cn";
import { Separator } from "@/components/ui/separator.jsx";

const WORKSPACE_ITEMS = [
  { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { id: "matches", label: "AI Analysis", icon: ScanSearch },
  { id: "commentary", label: "Commentary", icon: MessagesSquare },
  { id: "audio", label: "Audio", icon: AudioWaveform },
];

const CONFIGURATION_ITEMS = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "api-keys", label: "AI Providers", icon: KeyRound },
  { id: "tts-studio", label: "Voice Providers", icon: Mic },
  { id: "prompt-packs", label: "Prompt Packs", icon: ScrollText },
  { id: "preferences", label: "General", icon: Settings },
];

function NavButton({ id, label, Icon, selected, collapsed, onSelect }) {
  return (
    <button
      key={id}
      type="button"
      aria-label={label}
      aria-current={selected ? "page" : undefined}
      title={collapsed ? label : undefined}
      onClick={() => onSelect(id)}
      className={cn(
        "relative flex shrink-0 items-center gap-2.5 rounded-sm text-[12px] font-medium transition-colors duration-150",
        collapsed ? "size-9 justify-center px-0" : "w-full px-2.5 py-[7px] text-left",
        "text-muted-foreground hover:bg-accent hover:text-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected && "bg-accent font-medium text-foreground",
      )}
    >
      {selected ? (
        <span aria-hidden className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-ring" />
      ) : null}
      <Icon className="size-4 shrink-0" aria-hidden />
      {!collapsed ? <span className="truncate">{label}</span> : null}
    </button>
  );
}

function NavGroup({ title, items, active, collapsed, onSelect }) {
  if (items.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      {!collapsed ? (
        <p className="px-2.5 pb-2 pt-2 text-[10px] font-medium uppercase tracking-[0.12em] text-subtle">
          {title}
        </p>
      ) : null}
      {items.map(({ id, label, icon }) => (
        <NavButton
          key={id}
          id={id}
          label={label}
          Icon={icon}
          selected={id === active}
          collapsed={collapsed}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}

export default function Sidebar({ active, onSelect, collapsed, inWorkspace }) {
  return (
    <aside
      className={cn(
        "flex h-full shrink-0 flex-col overflow-hidden border-r border-border bg-surface transition-[width] duration-150 motion-reduce:transition-none",
        collapsed ? "w-[52px]" : "w-[196px]",
      )}
      aria-label="Application navigation"
    >
      <nav
        id="studio-navigation"
        aria-label="Studio sections"
        className={cn("flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto py-3", collapsed ? "items-center px-1" : "px-2")}
      >
        {inWorkspace ? (
          <NavButton
            id="editor"
            label="Editor"
            Icon={Clapperboard}
            selected={active === "editor"}
            collapsed={collapsed}
            onSelect={onSelect}
          />
        ) : null}
        <NavGroup
          title="Workspace"
          items={WORKSPACE_ITEMS}
          active={active}
          collapsed={collapsed}
          onSelect={onSelect}
        />
        <NavGroup
          title="Configuration"
          items={CONFIGURATION_ITEMS}
          active={active}
          collapsed={collapsed}
          onSelect={onSelect}
        />
      </nav>
      <Separator />
      {!collapsed ? (
        <div className="flex shrink-0 items-center justify-between px-3.5 py-2.5">
          <span className="text-[10px] text-subtle">Local workspace</span>
          <span className="font-mono text-[10px] text-subtle">1.0.0</span>
        </div>
      ) : (
        <div className="h-9 shrink-0" aria-hidden="true" />
      )}
    </aside>
  );
}
