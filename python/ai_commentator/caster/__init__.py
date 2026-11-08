"""Caster-first intelligence: beats, analyst, and producer.

Deterministic, model-free stages that turn validated gameplay
interpretation (``gameplay-v1``), match state, detected events, and
gated commentary claims into a chronological caster beat sheet. Beats
wrap gated claims (``source_claim_ids`` are ``claim_id_of`` values), so
the downstream ``script-v1`` shape is unchanged and TTS/export keep
working. No model calls happen anywhere in this package.
"""
