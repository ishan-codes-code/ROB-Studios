export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  provider: { type: 'openai-compatible', baseUrl: 'https://inference.baseten.co/v1', model: 'meta-models/muse-spark-open', modelVisionVerified: false },
  game: { id: 'free-fire', context: '' },
  prompt: { personality: 'Esports commentator', tone: 'energetic', language: 'English', instructions: '' },
  tts: { model: null, voice: null, voiceDirection: null, credentialId: null },
  onboardingCompleted: false,
  // Guided-setup progress: furthest step reached (0-4) plus the vault
  // credential created inside the wizard, so resuming never duplicates
  // it. Cleared logically once onboardingCompleted flips true.
  // `dismissed` records an explicit Finish-later exit: the wizard
  // stays hidden without falsely marking setup complete.
  onboarding: { step: 0, credentialId: null, dismissed: false },
});
