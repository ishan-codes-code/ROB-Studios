import FloatingNavigation from "@/components/navigation/floating-navigation";
import CapabilitiesSection from "@/components/sections/capabilities-section";
import CommentaryDemo from "@/components/sections/commentary-demo";
import FinalCta from "@/components/sections/final-cta";
import FutureSection from "@/components/sections/future-section";
import GameplayShowcase from "@/components/sections/gameplay-showcase";
import HeroSection from "@/components/sections/hero-section";
import ProductIntroduction from "@/components/sections/product-introduction";
import StudioPreview from "@/components/sections/studio-preview";
import WorkflowSection from "@/components/sections/workflow-section";
import StackedPanels from "@/components/stacked-panels";

export default function Home() {
  return (
    <main className="marketing-page">
      <a href="#introduction" className="skip-link">Skip to content</a>
      <FloatingNavigation />
      <StackedPanels>
        <HeroSection />
        <ProductIntroduction />
        <GameplayShowcase />
        <CommentaryDemo />
        <CapabilitiesSection />
        <WorkflowSection />
        <StudioPreview />
        <FutureSection />
        <FinalCta />
      </StackedPanels>
    </main>
  );
}
