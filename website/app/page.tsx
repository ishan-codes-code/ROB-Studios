import CapabilitiesSection from "@/components/sections/capabilities-section";
import FinalCta from "@/components/sections/final-cta";
import FutureSection from "@/components/sections/future-section";
import HeroSection from "@/components/sections/hero-section";
import ProductIntroduction from "@/components/sections/product-introduction";
import WorkflowSection from "@/components/sections/workflow-section";

export default function Home() {
  return (
    <main className="marketing-page">
      <HeroSection />
      <ProductIntroduction />
      <CapabilitiesSection />
      <WorkflowSection />
      <FutureSection />
      <FinalCta />
    </main>
  );
}
