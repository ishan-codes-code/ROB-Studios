# Architecture Decision Records

Short records of durable architectural decisions. Each ADR captures why a
decision was made so future agents do not re-litigate it without new evidence.

## Format

Create one file per decision: `docs/decisions/NNNN-short-title.md`, with:

- **Context** — the situation and constraints at decision time.
- **Decision** — what was chosen.
- **Alternatives considered** — what else was weighed, and why not.
- **Consequences** — what follows from the choice (benefits and costs).
- **Status** — `proposed`, `accepted`, or `superseded` (with a pointer).

Keep each ADR to one focused decision. Routine implementation choices do
not need an ADR; record choices that constrain future work.

## Records

- [0001 — Docker-first development](0001-docker-first-development.md)
- [0002 — Native Electron and Python development](0002-native-electron-python.md)
- [0003 — Modular engine and Electron main process](0003-modular-engine-and-electron-process.md)
- [0004 — Adaptive LLM-guided sampling engine](0004-adaptive-sampling-engine.md)
- [0005 — Stdin cooperative-stop transport](0005-stdin-cooperative-stop-transport.md)
- [0006 — Structured adaptive progress messages](0006-structured-adaptive-progress.md)
- [0007 — Global settings and provider credential boundary](0007-user-settings-and-credentials.md)
- [0008 — Explicit Meta/Baseten provider adapters](0008-explicit-provider-adapters.md)
- [0009 — Multi-credential encrypted vault and safe migration](0009-multi-credential-vault.md)
- [0010 — Project-level configuration with run-time resolution](0010-project-level-configuration.md)
- [0011 — Provider verification corrections](0011-provider-verification-corrections.md)
- [0012 — Game prompt packs with immutable factory defaults](0012-game-prompt-packs.md)
- [0013 — Streaming pipeline as opt-in threaded stages](0013-streaming-pipeline.md)
- [0014 — User-configured OpenAI-compatible custom provider](0014-custom-openai-compatible-provider.md)
- [0015 — Temporal gameplay event intelligence as an additive extension](0015-temporal-event-intelligence.md)
