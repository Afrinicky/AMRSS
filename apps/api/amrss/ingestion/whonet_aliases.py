"""WHONET code aliases the ingestion resolves automatically.

A laboratory's WHONET export names organisms, specimens and agents with WHONET's
own short codes. The canonical dictionary is seeded with those same codes wherever
it can be, so most resolve directly. The exceptions are codes whose canonical
entry already exists under a *different* code — recording the same thing twice
under two codes would split its counts — and those are listed here so ingestion
maps them without a steward having to.

This is deliberately small. It is not a substitute for the canonical dictionary:
a WHONET code that names something the dictionary genuinely does not hold is added
to the dictionary under that code, not aliased to an approximation here. Anything
still unresolved after this surfaces as a QC finding and the facility-code mapping
queue, so it is visible rather than silently dropped.
"""

from amrss.models.enums import DictionaryEntityType

#: WHONET code (lower-cased) -> canonical dictionary code.
_ORGANISM_ALIASES = {
    # WHONET's "Staphylococcus, coagulase negative" is seeded as ``cns``.
    "scn": "cns",
}

_SPECIMEN_ALIASES: dict[str, str] = {}

_ANTIBIOTIC_ALIASES: dict[str, str] = {}

_BY_ENTITY = {
    DictionaryEntityType.ORGANISM: _ORGANISM_ALIASES,
    DictionaryEntityType.SPECIMEN_TYPE: _SPECIMEN_ALIASES,
    DictionaryEntityType.ANTIBIOTIC: _ANTIBIOTIC_ALIASES,
}


def whonet_alias(entity_type: DictionaryEntityType, code: str) -> str | None:
    """The canonical code a WHONET code aliases to, or None if it is not aliased.

    Case-insensitive: WHONET organism and specimen codes are lower-case while its
    antibiotic codes are upper-case, and a facility's export may not be tidy.
    """
    return _BY_ENTITY.get(entity_type, {}).get(code.strip().lower())


def aliased_codes(entity_type: DictionaryEntityType) -> frozenset[str]:
    """Every WHONET code this layer resolves for an entity, for the QC known-set."""
    return frozenset(_BY_ENTITY.get(entity_type, {}))
