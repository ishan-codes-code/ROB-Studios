# ADR 0010: Project-level configuration with run-time resolution

- Status: Accepted
- Date: 2026-11-02

## Context

Provider credentials are global resources, but the active selection
belongs to a project. The worker must receive exactly one run's key and
model without ever seeing the vault, and later UI edits must not
affect a running job.

## Decision

Projects store `configuration: {credentialId, gameProfileId,
commentaryPresetId}` in `project.json` (defaults: no credential,
built-in Free Fire profile and preset; legacy projects default on
read). Game profiles and commentary presets live in a global
game-library file with code-synthesized immutable built-ins. At run
start the main process resolves references via `resolveProjectRunConfig`
into a non-secret snapshot (provider, model, key, bounded preferences);
paid runs additionally require image verification for the exact
credential version/model. The worker receives the snapshot through the
new `AI_COMMENTATOR_*` environment contract (legacy `BASETEN_*`
mirrored for Baseten runs only), with unrelated host secrets stripped
before spawn. The NDJSON protocol and stdin stop channel are unchanged.

## Consequences

Renderer Configure tab selects (never manages) configurations, with
manage-links to the vault and library pages. Renderer tests cover the
selector logic; main-process tests cover resolution, missing/unverified
references, and no-fallback behavior. Game presets outside Free Fire,
cloud sync, and arbitrary endpoints remain out of scope. See
`docs/contracts/project-configuration-v1.md` and
`docs/contracts/worker-runtime-config.md`.
