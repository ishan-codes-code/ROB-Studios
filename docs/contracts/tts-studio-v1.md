# Contract: TTS Studio configuration v1 (`tts-studio-v1`)

Versioned contract for the TTS Studio (roadmap milestone M7): the voice
catalogue source of truth, global/project TTS configuration with
precedence, the main/renderer IPC surface, preview synthesis behavior,
and the secure credential flow into runs. The synthesis itself stays in
`tts-v1` (`tts-v1.md`); this document owns everything around it.

## Catalogue (single source of truth)

`python/tts_catalog.py` prints one JSON line built purely from the
pinned `ai_commentator.tts.config`:

```json
{
  "ok": true,
  "models": [{"id": "gemini-3.8-flash-tts", "description": "..."}],
  "voices": [{"id": "Kore", "character": "Firm"}],
  "defaults": {"model": "...", "voice": "...", "voiceDirection": "..."},
  "limits": {"voiceMaxLength": 64, "voiceDirectionMaxLength": 500}
}
```

The probe is offline (no key, no network). The Electron main process
fetches it via one-shot spawn, validates the shape, and caches it for
the application session. The renderer must never hardcode its own
model or voice list: pickers render this catalogue, and membership
checks use it. If Gemini's catalogue changes, only `tts/config.py`
changes; no renderer edit is needed.

## Configuration schema

Two partial layers, each `{model, voice, voiceDirection, credentialId}`
where `null` means "inherit from the layer below" (for `credentialId`,
`null` at every layer means "none selected"):

- Global defaults: `settings.json` → `tts` section (all four fields,
  validated on save, atomically written with the rest of settings).
- Project overrides: `project.json` → `configuration.tts` (partial;
  older projects without the key inherit fully and are never rewritten
  except by an explicit TTS save).

Field rules (validated main-side on save and use; Python re-validates
authoritatively at synthesis):

| Field | Rule |
|---|---|
| `model` | Non-empty string, must be a catalogue member — never silently substituted |
| `voice` | Bounded string, 1–64 chars (prebuilt, library, or custom `voice_...` IDs) |
| `voiceDirection` | Bounded string, 1–500 chars; delivery style, never commentary content |
| `credentialId` | Null or an existing vault record whose purpose is `tts` |

Voice and direction are whitespace-trimmed on save, exactly like the
Python validators, so the stored value always equals the sent value;
model and credentialId keep their spelling.

Precedence (highest wins): **project override > global default >
application default** (catalogue defaults). Resolution returns the
effective triple plus per-field sources so the UI can label each value
as override, global, or application default.

No API credentials and no audio bytes are ever stored in these
settings. Switching projects loads that project's effective
configuration; saving survives application restart (plain file
persistence, no migration needed — missing layers default to inherit).

## IPC surface (main-validated, secret-free)

Exposed in `preload.js` (`getTtsCatalog`, `getTtsConfig`, `setTtsConfig`,
`previewTts`). Every argument is validated in the main process; key
material never crosses IPC in either direction.

- `tts-catalog` () → `{ok, catalog, previewPhrase, textLimit}`.
  `previewPhrase` is the fixed studio preview line; `textLimit` (500)
  bounds preview/custom text to cap paid preview cost (a client-side
  guard — the synthesis client imposes no text cap).
- `tts-config-get` (projectId|null) → `{ok, global, project, resolved,
  sources, credentialId, credentialSource, credential, warnings,
  appDefault}`. `credential` is sanitized metadata
  (`{id, name, provider, verified}`); `warnings` carries actionable
  credential problems.
- `tts-config-set` ({scope: 'global'|'project', projectId?, patch}) →
  the `tts-config-get` shape after saving. Only provided patch keys are
  written (explicit `null` resets a field to inherit); unknown keys,
  off-catalogue models, and non-TTS credentials are rejected with
  nothing persisted. This channel is the single writer for TTS fields:
  `project-config-set` refuses any `tts` key.
- `tts-preview` ({text, model, voice, voiceDirection, projectId?,
  credentialId?}) → `{ok, audioBase64, bytes, mimeType: 'audio/wav',
  config: {model, voice}}`. The triple must be complete and the model
  on-catalogue; `text` must be non-empty, within `textLimit`, and must
  not start with a dash (it travels as a positional argv token). The
  credential resolves as explicit override > project > global, must
  exist, must have purpose `tts`, and must be verified (same paid-run
  gating as vision). Failures return `{ok: false, error, code}` with
  `code` in `no-credential`, `unverified`, `config`, `preview-failed`.

Stored settings can outlive the catalogue (e.g. a removed model).
`tts-config-get` then still succeeds: the voice triple falls back to
application defaults with an explicit warning while the stored
credential stays visible, so the user can repair and save. Preview
and run resolution stay strict and fail closed — the fallback never
reaches synthesis.

## Preview behavior

Previews spawn the existing `python/tts_say.py` (no second engine) with
the key in the child environment only. The main process writes to a
random temp file under `userData/tts-previews/`, reads the WAV back
(non-empty, capped at 8 MiB), deletes the file immediately on success
and failure paths, sweeps crash leftovers older than one hour, and
returns base64 audio. External error text is key-scrubbed and bounded.

Previews never modify the project's script, manifest, segments, or any
project artifact. The renderer replays from revocable object URLs and
caches identical requests to avoid repeat paid calls.

## Run integration

Renderer run options carry two paid opt-ins (default off):
`withScript` and `requestTts` (audio requires the script; enforced
renderer-side, main-side, and worker-side). For project runs with
`requestTts`, the main process resolves the effective triple plus the
vault TTS key (`resolveTtsRunConfig`), passes
`--generate-tts --tts-model/--tts-voice/--tts-voice-direction` (values
from stored configuration only — renderer-supplied TTS argv is
stripped), and injects `AI_COMMENTATOR_PROVIDER_API_KEY` into the
worker environment. Non-project runs cannot request TTS. The worker
re-validates the triple with `validate_tts_config`, fails fast without
key or with invalid config, and the `tts-v1` manifest records the
configuration actually used.

## Credential flow

TTS keys live only in the `safeStorage` vault as purpose-`tts`
records (`provider-vault-v1.md`). Retrieval uses the existing
`getCredentialForRun` plus purpose and verification gates; deletion is
refused while any project override or the global default references
the credential (`referencedBy` / `referencedByGlobal`). The worker and
preview children receive the key exclusively through
`AI_COMMENTATOR_PROVIDER_API_KEY` beside (never mixed with) the vision
key; host secrets are stripped before spawn.

## Limitations

- Projects cannot express "no credential" while a global default
  exists (`null` always means inherit).
- Catalogue changes require an application restart (session cache).
- Previews and runs require a verified TTS credential even though TTS
  verification only proves authentication and model metadata, not
  inference entitlement.

## Compatibility

- Additive to `settings.json` and `project.json`: older files without
  TTS sections read as full-inherit.
- `tts-v1` and `script-v1` are unchanged by this contract.
- Field or channel additions require a version bump; readers reject
  unknown TTS configuration fields rather than guessing.
