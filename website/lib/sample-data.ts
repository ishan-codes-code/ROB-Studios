// Replaceable illustrative demo content. Not real match analysis.
export type DemoEvent = {
  id: string; label: string; time: string; observation: string; context: string; commentary: string; confidence: string;
};
export const DEMO_EVENTS: DemoEvent[] = [
  { id: "ridge", label: "Ridge pressure", time: "18:42", observation: "Two opponents visible closing from the ridge line. Player behind low cover, shield at half.", context: "Late circle · 3 squads remaining · player outnumbered on high ground", commentary: "Two opponents are closing in from the ridge. The player needs to reposition before the next engagement.", confidence: "Illustrative · gated by visible evidence" },
  { id: "rotation", label: "Late rotation", time: "21:07", observation: "Player rotating along the zone edge. No opponents in frame. Zone timer under 20 seconds.", context: "Zone closing · rotation path exposed · no confirmed contact", commentary: "A quiet rotation along the edge of the zone — no contact yet, but the next circle will force a decision.", confidence: "Illustrative · no unsupported contact claimed" },
  { id: "fight", label: "Third-party risk", time: "24:31", observation: "Two squads exchanging fire ahead. Player approaching from the flank, unspotted in frame.", context: "Active fight nearby · flank available · third-party window opening", commentary: "Two squads are already locked in ahead. This is the moment a third party changes everything.", confidence: "Illustrative · fight confirmed in frame" },
];
export const NAV_SECTIONS = [
  { id: "introduction", label: "Intro", num: "02" },
  { id: "showcase", label: "Gameplay", num: "03" },
  { id: "demo", label: "Intelligence", num: "04" },
  { id: "capabilities", label: "Capabilities", num: "05" },
  { id: "workflow", label: "Workflow", num: "06" },
  { id: "studio", label: "Studio", num: "07" },
  { id: "roadmap", label: "Roadmap", num: "08" },
] as const;
