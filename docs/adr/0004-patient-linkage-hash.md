# ADR-0004 — Patient linkage key: facility-local salt, one-way hash

**Status:** Accepted
**Relates to:** SDD §3.1, §3.2, §5.3, §8.2

## Context

CLSI M39 antibiogram methodology requires first-isolate-per-patient
deduplication. That requires knowing that two isolates came from the same patient.
The system must never be able to learn *which* patient.

## Decision

The offline uploader computes `Argon2id(patient_identifier, salt)` where the salt
is generated once per facility, stored only on the facility's machine, and never
transmitted. Only the resulting key travels.

Argon2id rather than a plain SHA-256 HMAC: patient identifier spaces are small and
guessable (sequential hospital numbers, national ID formats). A fast hash of a
low-entropy input is reversible by exhaustive search even when salted, if the salt
ever leaks. A memory-hard KDF makes that attack expensive rather than trivial,
which is the difference between a control and the appearance of one.

## Consequences

- **The salt is unrecoverable.** If a facility loses its machine, its historical
  linkage keys cannot be regenerated and prior isolates from a patient will no
  longer link to new ones. This is a deliberate trade: it is the property that makes
  the key genuinely irreversible. The uploader therefore treats salt backup as an
  explicit, documented facility responsibility with a guided export.
- Linkage keys are scoped per facility. Cross-facility patient linkage is not
  possible and is not a goal.
- The key is used only inside the deduplication step of the analytics engine. It
  is never displayed, exported, or included in any report or API response. This is
  enforced by schema-level exclusion in the serialisation layer, not by convention.
- Hash parameters are versioned. Changing them changes all subsequently computed
  keys, so a change is a migration event, not a config tweak.
