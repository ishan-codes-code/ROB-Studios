# Worker runtime configuration

How the Electron main process configures one Python worker run. The
NDJSON protocol itself is unchanged — see
[worker-protocol.md](worker-protocol.md); this document owns the child
environment contract that replaced the single-provider `BASETEN_*`
assumption.

## Environment (per-run, secrets only for that child)

| Variable | Meaning |
| --- | --- |
| `AI_COMMENTATOR_PROVIDER` | `meta` or `baseten` (explicit, validated) |
| `AI_COMMENTATOR_MODEL` | Curated model ID for that provider |
| `AI_COMMENTATOR_API_KEY` | Decrypted key for the selected credential only |
| `AI_COMMENTATOR_SETTINGS_JSON` | Non-secret `{game, prompt}` preferences |
| `BASETEN_API_KEY` | Legacy mirror of the run key (fallback compat) |
| `BASETEN_BASE_URL` / `BASETEN_MODEL` | Mirrored only for Baseten runs |

The Python engine resolves the active adapter from the explicit trio
via `vision/providers/registry.py`: `AI_COMMENTATOR_*` wins; absent
those, a legacy `BASETEN_*` pair resolves as a Baseten configuration
(never cross-provider guessing); absent keys fail fast before any paid
call or extraction work. The worker `require_key` message names both
variables so legacy setups stay diagnosable.

No provider metadata comes from the renderer at run time: the main
process resolves the project's stored credential ID through the vault
and injects the fixed catalogue base URL. Arbitrary URLs cannot reach
the worker. The key never appears in argv, stdin (reserved for the
versioned stop line), NDJSON, files, or renderer state, and the child
no longer inherits unrelated host secrets (`API_KEY`/`SECRET`/`TOKEN`
/`PASSWORD`-shaped variables are stripped before spawn).

## Verification gate

Paid runs require a vault credential whose verification is `verified`
for the exact credential version and model. The gate lives in the main
process (`resolveProjectRunConfig`); the worker's fail-fast key check
remains as a second layer. Test connection and image verification run
through `python/provider_setup.py` as one-shot JSON operations
(`connection`, `models`, `verify-vision`) with `--provider`; `models`
returns the curated catalogue (all `unverified` by design) instead of
live discovery.

## Setup failure contract

Failures are structured, not generic: `{"ok": false, "error",
  "code", "status", "provider", "operation", "detail"}` where
  `error` is a secret-free actionable message, `code` a stable
category (`auth`, `model`, `image`, `bad_request`, `rate_limit`,
`timeout`, `network`, `bad_response`, `config`, `provider_error`,
`unknown`, plus `stale` for verification raced by a mid-flight
edit), `status` the HTTP status when known, and `detail` a
truncated sanitized note for logs. Raw provider bodies and key
material never cross this boundary; the Electron layers forward
these fields instead of substituting their own generic message.
