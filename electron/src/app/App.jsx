import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Toaster } from "@/components/ui/sonner.jsx";
import AppLayout from "@/layout/AppLayout.jsx";
import AppHeader from "@/layout/AppHeader.jsx";
import Sidebar from "@/layout/Sidebar.jsx";
import TitleBar from "@/layout/TitleBar.jsx";
import DashboardSection from "@/app/sections/DashboardSection.jsx";
import MatchesSection from "@/app/sections/MatchesSection.jsx";
import CommentarySection from "@/app/sections/CommentarySection.jsx";
import OnboardingWizard from "@/app/sections/OnboardingWizard.jsx";
import ApiKeysSection from "@/app/sections/ApiKeysSection.jsx";
import GameProfilesSection from "@/app/sections/GameProfilesSection.jsx";
import CommentaryPresetsSection from "@/app/sections/CommentaryPresetsSection.jsx";
import OverviewSection from "@/app/sections/OverviewSection.jsx";
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
  overview: OverviewSection,
  "api-keys": ApiKeysSection,
  "game-profiles": GameProfilesSection,
  "commentary-presets": CommentaryPresetsSection,
  "prompt-packs": PromptPacksSection,
  "tts-studio": TtsStudioSection,
  preferences: PreferencesSection,
};

const SECTION_META = {
  dashboard: { title: "Dashboard", context: "Project library" },
  matches: { title: "AI Analysis", context: "Validated observations and events" },
  commentary: { title: "Commentary", context: "Generated lines and scripts" },
  audio: { title: "Audio", context: "Playback lanes are not available yet" },
  overview: { title: "Overview", context: "Configuration status at a glance" },
  "api-keys": { title: "AI Providers", context: "Vision and speech provider configurations" },
  "game-profiles": { title: "Game Profiles", context: "Match-context records" },
  "commentary-presets": { title: "Commentary Presets", context: "Commentary personalities and tones" },
  "prompt-packs": { title: "Prompt Packs", context: "Game-specific prompt wording and defaults" },
  "tts-studio": { title: "Voice Providers", context: "Commentary voice configuration and previews" },
  preferences: { title: "General", context: "Application preferences" },
};

export default function App() {
  const [activeSection, setActiveSection] = useState("dashboard");
  const [workspaceId, setWorkspaceId] = useState(null);
  const [projectName, setProjectName] = useState(null);
  const [navigationCollapsed, setNavigationCollapsed] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  // First-launch guided setup: takes over the window until completed or
  // deferred ("Finish later" returns to the dashboard; progress resumes
  // next launch). Null while the settings check is in flight.
  const [onboarding, setOnboarding] = useState(null);
  // Sidebar state before the editor auto-collapsed it; restored when
  // leaving the workspace so the toggle stays predictable.
  const savedNavigationCollapsed = useRef(null);

  useEffect(() => {
    let alive = true;
    window.api?.loadSettings?.().then((result) => {
      if (!alive) return;
      if (result?.ok && !result.settings?.onboardingCompleted) {
        setOnboarding({ settings: result.settings });
      } else {
        setOnboarding(false);
      }
    }).catch(() => {
      if (alive) setOnboarding(false);
    });
    return () => { alive = false; };
  }, []);

  const handleOnboardingComplete = useCallback(({ projectId } = {}) => {
    setOnboarding(false);
    if (projectId) {
      handleOpenProjectRef.current?.(projectId);
    } else {
      setActiveSection("dashboard");
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

  const handleOpenProjectRef = useRef(handleOpenProject);
  handleOpenProjectRef.current = handleOpenProject;

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

  const handleProjectDeleted = useCallback((id) => {
    // Deleting the open project invalidates the editor workspace:
    // clear it so no stale state survives for a removed project.
    if (workspaceId !== null && id === workspaceId) {
      handleBackToProjects();
    }
  }, [workspaceId, handleBackToProjects]);

  const handleProjectLoaded = useCallback((project) => {
    setProjectName(project.name);
  }, []);

  const handleBackToEditor = useCallback(() => {
    if (workspaceId !== null) setActiveSection("editor");
  }, [workspaceId]);

  if (onboarding) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
        <TitleBar context="Setup" />
        <div className="min-h-0 min-w-0 flex-1">
          <OnboardingWizard
            initialSettings={onboarding.settings}
            onComplete={handleOnboardingComplete}
            onExit={() => setOnboarding(false)}
          />
        </div>
        <Toaster theme="dark" position="bottom-right" />
      </div>
    );
  }

  return (
    <>
    <AppLayout
      titlebar={<TitleBar context={meta.title} />}
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
              onNavigate={handleSelectSection}
            />
          ) : (
            <div className="h-full min-h-0 overflow-y-auto px-5 py-4">
              <SectionView
                {...(activeSection === "dashboard"
                  ? { onOpenProject: handleOpenProject, onProjectDeleted: handleProjectDeleted }
                  : {})}
                {...(activeSection === "audio"
                  ? { section: activeSection }
                  : {})}
                {...(workspaceId !== null &&
                (activeSection === "api-keys" || activeSection === "game-profiles"
                  || activeSection === "commentary-presets" || activeSection === "prompt-packs")
                  ? { onBackToEditor: handleBackToEditor }
                  : {})}
                {...(activeSection === "overview"
                  ? { onNavigate: handleSelectSection }
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
