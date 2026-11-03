# ADR 0014: User-configured OpenAI-compatible custom provider

- Status: Accepted
- Date: 2026-11-03
- Supersedes: the "no arbitrary endpoints" constraint of
  [ADR 0008](0008-explicit-provider-adapters.md) for one new,
  explicitly validated provider type only. Meta and Baseten keep
  their pinned endpoints and curated catalogues exactly as before.

## Context

The configuration redesign requires three vision provider choices —
Meta, Baseten, and a custom OpenAI-compatible endpoint — with model
discovery, manual model entry, connection testing, and explicit image
verification for the custom type. ADR 0008 rejected a single generic
client with interchangeable base URLs because it hid provider
differences and invited arbitrary endpoints. The requirement is now
real, so the question is how to admit user endpoints without
reintroducing the risks ADR 0008 named: key material sent to the
wrong host, unverified image claims, and silent substitution.

## Decision

Add `custom` as a third explicit provider behind the same adapter
boundary, with per-record validated endpoints instead of a generic
interchangeable client:

- **Electron catalogue** (`provider-catalog.mjs`): a `custom` entry
  with `customEndpoint: true`, no pinned URL, and no curated models.
  `validateCustomBaseUrl` enforces public HTTPS (no credentials,
  query, or fragment) and blocks localhost plus loopback,
  link-local, and RFC 1918 targets. Model IDs are explicit and
  bounded, never curated.
- **Vault** (`credentials-store.mjs`): custom records store `baseUrl`
  as non-secret index metadata; curated records reject the field, so
  a stored URL can never redirect a curated provider's key.
  Verification pins the exact key version, model, **and** endpoint;
  changing any of the three resets it.
- **Python** (`vision/providers/custom.py`): a `CustomAdapter`
  speaking plain Chat Completions (no provider-specific extras) with
  request-time URL re-validation, secret-free errors, a minimal
  text-only connection probe (no `/models` assumption), the shared
  red-square live image probe, and best-effort `GET /models`
  discovery that reports `discovery_unsupported` (404/405/501 or an
  unparseable body) so the UI offers manual entry. Discovery
  membership never implies image capability.
- **Transport**: the key travels only to the configured host. HTTP
  redirect behavior is the OpenAI SDK default (httpx strips
  `Authorization` on cross-origin redirects); same-origin redirects
  keep working. Residual DNS-rebinding risk is documented, not
  solved: configuration-time checks cover literal targets, and the
  endpoint is pinned per record at verification and run time.
- **Runs**: `AI_COMMENTATOR_BASE_URL` is injected only for custom
  runs from the saved record; curated runs never see it. The engine
  resolves custom through `resolve_provider_config` (which carries
  a `base_url` key for custom resolutions only) and builds the
  adapter in every live-client site (batch, adaptive, writer,
  script).

## Alternatives considered

- Keep two curated providers only (rejected: the product brief
  explicitly requires custom endpoints).
- One generic client with a runtime-swappable base URL (rejected:
  same objection as ADR 0008 — it would let any key meet any host;
  the per-record pinned endpoint plus verification binding is the
  containment that makes custom endpoints acceptable).
- Live discovery for Meta/Baseten too (rejected: their catalogues
  stay curated and keyless; only custom dials discovery, and only
  on explicit user action).

## Consequences

- Users can point vision at any public OpenAI-compatible HTTPS
  endpoint with honest states (saved, connected, model selected,
  vision verified, needs attention) and no silent fallbacks.
- Paid verification semantics are unchanged: no background checks,
  stale-snapshot guards now also pin the endpoint, and every
  verification failure keeps its structured secret-free shape with
  one new code (`discovery_unsupported`).
- Costs: a third adapter to maintain, plus a documented residual
  risk that a hostile DNS name could resolve a validated hostname
  to a private address at request time (mitigation: per-record
  pinning, HTTPS-only, no credentialed URLs, key sent only to the
  configured host).
