export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  provider: { type: 'openai-compatible', baseUrl: 'https://inference.baseten.co/v1', model: 'meta-models/muse-spark-open', modelVisionVerified: false },
  game: { id: 'free-fire', context: '' },
  prompt: { personality: 'Esports commentator', tone: 'energetic', language: 'English', instructions: '' },
  tts: { model: null, voice: null, voiceDirection: null, credentialId: null },
  onboardingCompleted: false,
});
