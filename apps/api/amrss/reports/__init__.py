"""Report generation (SDD 9.7).

Split three ways on purpose:

- ``build`` assembles the content by driving the *same* analytics engine the
  dashboard uses. That is the load-bearing decision: a report must never show
  something the live dashboard would have withheld, and the only reliable way to
  guarantee that is to make it impossible to compute the numbers differently.
- ``excel`` and ``pdf`` render that content. They format; they never decide what
  is reportable. A renderer that could reach past a suppressed cell would defeat
  the guarantee above, so they are handed a structure in which suppressed cells
  already carry no values to reach for.
"""
