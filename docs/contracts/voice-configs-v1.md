# Contract: reusable voice configurations v1 (`voice-configs-v1`)

Versioned contract for the editor Voice tab's reusable TTS voice
library: the stored entry schema, the main/renderer IPC surface, the
copy-on-apply rule into projects, and the credential-reference flow.
Voice synthesis itself stays in `tts-v1.md`; catalogue, project-layer
precedence, preview synthesis, and run resolution stay in
`tts-studio-v1.md` — this document owns only the library around them.

## Entry schema

`voice-configs.json` (Electron `userData`, alongside the other
stores) holds `{version: 1, configs: [...]}` with atomic temp-file
writes. Each entry is a complete preset:

```json
{
  "id": "voice-9f3a2b1c4d5e",
  "name": "Ranked grind",
  "providerId": "google-gemini-tts",
  "credentialId": "cred-abc123",
  "model": "gemini-3.8-flash-tts",
  "voice": "Kore",
  "voiceDirection": "Energetic esports commentator.",
  "createdAt": "2026-11-04T00:00:00.000Z",
  "updatedAt": "2026-11-04T00:00:00.000Z"
}
```

Field rules (validated main-side on write; readers reject unknown
fields rather than guessing):

| Field | Rule |
|---|---|
| `id` | `voice-` + 12 hex chars, assigned main-side |
| `name` | Trimmed 1–80 chars, unique case-insensitively |
| `providerId` | A known provider whose purpose is `tts` (today only `google-gemini-tts`); pinned from vault metadata when the credential resolves |
| `credentialId` | Null or a vault record id — a stable reference, never key material; dangling ids are tolerated at rest and resolved at apply time |
| `model` | Non-empty string, ≤200 chars (catalogue membership is an apply-time gate, not a save-time gate) |
| `voice` | Trimmed 1–64 chars, same bounds as synthesis time |
| `voiceDirection` | Trimmed 1–500 chars; delivery style, never commentary content |

The library is global (shared across projects) and holds user
presets only — no built-ins. A missing file reads as empty; a
corrupt file (bad JSON, wrong version, invalid entry, duplicate
names) fails closed with no silent drops. Entries must survive
catalogue changes and credential rotations: shape is validated on
write, compatibility on use.

## IPC surface (main-validated, secret-free)

Exposed in `preload.js` (`listVoiceConfigs`, `createVoiceConfig`,
`updateVoiceConfig`, `deleteVoiceConfig`). Every argument is
validated in the main process; key material never crosses IPC in
either direction.

- `voice-config-list` () → `{ok, configs}`.
- `voice-config-create` (input) → `{ok, config}`. Unknown keys,
  incomplete triples, and non-TTS providers are rejected with
  nothing persisted.
- `voice-config-update` (id, patch) → `{ok, config}`. Rename and/or
  settings replace; explicit `null` clears `credentialId` only — the
  triple stays complete.
- `voice-config-delete` (id) → `{ok, deleted, id}`.

When `credentialId` resolves in the vault, its provider is stamped
onto the entry (a non-TTS purpose is rejected); when it does not
resolve, the save still succeeds with the caller's TTS provider so
presets outlive credential deletions. Library operations never
touch projects.

## Project assignment (copy, never reference)

Applying an entry copies its values into `project.json`
`configuration.tts` through the existing `tts-config-set` channel
(scope `project`), so all `tts-studio-v1` gates apply unchanged:
off-catalogue models and missing/non-TTS credentials are rejected
with nothing written. Editing a project's voice never mutates the
library entry; updating a library entry never rewrites projects
that previously applied it.

Apply-time compatibility (checked before the write, surfaced
inline): an entry whose model left the catalogue cannot apply; an
entry whose credential is unavailable applies its voice triple and
keeps the project's credential with an explicit notice.

## Preview integration

The Voice tab previews through the existing `tts-preview` channel
with an explicit model/voice/direction triple and credential —
the same path as the TTS Studio, no second pipeline. Previews
never modify project artifacts.

## Compatibility

- Additive: new store file, new channels, no changes to
  `tts-studio-v1` fields, `project.json` shape, or run resolution.
- The standalone Voice Providers page keeps its Global/Project
  scope workflow unchanged; the editor tab is inherently
  project-scoped and carries no scope selector.
- Field or channel additions require a version bump.
