"""Administrative modules: enrollment lifecycle, block management, stewardship.

Kept apart from `analytics` because these change *configuration* rather than
compute over data. Adding a regional block, activating a facility or approving a
code mapping all alter what future aggregates will say; none of them is a
calculation.
"""
