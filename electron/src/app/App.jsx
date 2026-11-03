import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Toaster } from "@/components/ui/sonner.jsx";
import AppLayout from "@/layout/AppLayout.jsx";
import AppHeader from "@/layout/AppHeader.jsx";
import Sidebar from "@/layout/Sidebar.jsx";
import DashboardSection from "@/app/sections/DashboardSection.jsx";
import MatchesSection from "@/app/sections/MatchesSection.jsx";
import CommentarySection from "@/app/sections/CommentarySection.jsx";
import ApiKeysSection from "@/app/sections/ApiKeysSection.jsx";
import GamesPromptsSection from "@/app/sections/GamesPromptsSection.jsx";
import PromptPacksSection from "@/app/sections/PromptPacksSection.jsx";
import PreferencesSection from "@/app/sections/PreferencesSection.jsx";
import TtsStudioSection from "@/app/sections/TtsStudioSection.jsx";
import WorkspaceSection from "@/app/sections/WorkspaceSection.jsx";
import StudioPlaceholder from "@/app/sections/StudioPlaceholder.jsx";
import { MOTION, EASING } from "@/lib/tokens.js";

const SECTION_VIEWS = {
  dashboard: DashboardSection,
  matches: MatchesSection,
  commentary: CommentarySection,
  audio: StudioPlaceholder,
  "api-keys": ApiKeysSection,
  "games-prompts": GamesPromptsSection,
  "prompt-packs": PromptPacksSection,
  "tts-studio": TtsStudioSection,
  preferences: PreferencesSection,
};

const SECTION_META = {
  dashboard: { title: "Dashboard", context: "Project library" },
  matches: { title: "AI Analysis", context: "Validated observations and events" },
  commentary: { title: "Commentary", context: "Generated lines and scripts" },
  audio: { title: "Audio", context: "Playback lanes are not available yet" },
  "api-keys": { title: "API Keys", context: "Saved provider configurations" },
  "games-prompts": { title: "Games & Prompts", context: "Game profiles and commentary presets" },
  "prompt-packs": { title: "Prompt Packs", context: "Game-specific prompt wording and defaults" },
  "tts-studio": { title: "TTS Studio", context: "Commentary voice configuration and previews" },
  preferences: { title: "Preferences", context: "Application preferences" },
};

export default function App() {
  const [activeSection, setActiveSection] = useState("dashboard");
  const [workspaceId, setWorkspaceId] = useState(null);
  const [projectName, setProjectName] = useState(null);
  const [navigationCollapsed, setNavigationCollapsed] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  // Sidebar state before the editor auto-collapsed it; restored when
  // leaving the workspace so the toggle stays predictable.
  const savedNavigationCollapsed = useRef(null);

  useEffect(() => {
    let alive = true;
    window.api?.loadSettings?.().then((result) => {
      if (alive && result?.ok && !result.settings?.onboardingCompleted) setActiveSection("api-keys");
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // The open project is preserved while visiting management pages so a
  // "Manage …" link never loses the editor's workspace state.
  const showingWorkspace = workspaceId !== null && activeSection === "editor";
  const SectionView = showingWorkspace ? null : (SECTION_VIEWS[activeSection] ?? DashboardSection);
  const meta = showingWorkspace
    ? { title: projectName ?? "Opening project…", context: "Editor" }
    : SECTION_META[activeSection] ?? SECTION_META.dashboard;

  const handleSelectSection = useCallback((id) => {
    setActiveSection(id);
  }, []);

  const handleBackToProjects = useCallback(() => {
    setWorkspaceId(null);
    setProjectName(null);
    setActiveSection("dashboard");
    if (savedNavigationCollapsed.current !== null) {
      setNavigationCollapsed(savedNavigationCollapsed.current);
      savedNavigationCollapsed.current = null;
    }
  }, []);

  const handleOpenProject = useCallback((id) => {
    setProjectName(null);
    setWorkspaceId(id);
    setActiveSection("editor");
    // The editor gets the available width; the user can still reopen
    // the sidebar manually, and leaving restores the previous state.
    setNavigationCollapsed((current) => {
      if (savedNavigationCollapsed.current === null) {
        savedNavigationCollapsed.current = current;
      }
      return true;
    });
  }, []);

  const handleProjectLoaded = useCallback((project) => {
    setProjectName(project.name);
  }, []);

  const handleBackToEditor = useCallback(() => {
    if (workspaceId !== null) setActiveSection("editor");
  }, [workspaceId]);

  return (
    <>
    <AppLayout
      sidebar={
        <Sidebar
          active={showingWorkspace ? "editor" : activeSection}
          onSelect={handleSelectSection}
          collapsed={navigationCollapsed}
          inWorkspace={workspaceId !== null}
        />
      }
      header={
        <AppHeader
          title={meta.title}
          context={meta.context}
          navigationCollapsed={navigationCollapsed}
          onToggleNavigation={() => setNavigationCollapsed((value) => !value)}
          inspectorOpen={inspectorOpen}
          showInspectorToggle={showingWorkspace}
          onToggleInspector={() => setInspectorOpen((value) => !value)}
        />
      }
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={showingWorkspace ? `workspace:${workspaceId}` : activeSection}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: MOTION.standard, ease: EASING.entrance }}
          className="h-full min-h-0 min-w-0"
        >
          {showingWorkspace ? (
            <WorkspaceSection
              projectId={workspaceId}
              inspectorOpen={inspectorOpen}
              onProjectLoaded={handleProjectLoaded}
              onBack={handleBackToProjects}
            />
          ) : (
            <div className="h-full min-h-0 overflow-y-auto px-5 py-4">
              <SectionView
                {...(activeSection === "dashboard"
                  ? { onOpenProject: handleOpenProject }
                  : {})}
                {...(activeSection === "audio"
                  ? { section: activeSection }
                  : {})}
                {...(workspaceId !== null &&
                (activeSection === "api-keys" || activeSection === "games-prompts" || activeSection === "prompt-packs")
                  ? { onBackToEditor: handleBackToEditor }
                  : {})}
              />
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </AppLayout>
    <Toaster theme="dark" position="bottom-right" />
    </>
  );
}
