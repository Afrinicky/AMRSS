# AMRSS Design Language

Applies to every AMRSS interface — web dashboard, offline uploader, and generated
reports. SDD §11.1 makes this a fixed design rule, not a per-screen decision.

## 1. Posture

Professional, standard, simple. This is a clinical-adjacent surveillance tool. It
should read as **credible and calm**, never flashy. Generous whitespace, clean
sans-serif type, rounded-corner cards, soft shadows, restrained layout rhythm.

A clinician opening the home page should be able to answer *"what are we seeing
now?"* without reading a dense analytics wall.

## 2. The two palettes — the central rule

**The brand palette governs chrome. It never governs clinical data.**

Chrome means navigation, cards, buttons, backgrounds, headers, links, focus rings.
Clinical data means anything encoding a susceptibility result, resistance rate,
severity, or trend direction.

Mixing them is the single easiest way to make this system misleading. A brand-green
button next to a brand-green cell that is *not* asserting "susceptible" teaches the
eye the wrong thing.

### 2.1 Brand palette (chrome)

| Token | Light | Dark | Use |
|---|---|---|---|
| `--brand-50` | `#EAF6EF` | `#0E1A13` | Tinted surfaces |
| `--brand-100` | `#CFEADB` | `#14261B` | Hover fills, subtle bands |
| `--brand-300` | `#7CC9A0` | `#2E6B49` | Borders on brand surfaces |
| `--brand-600` | `#1F7A4C` | `#39A16C` | Primary action, active nav |
| `--brand-700` | `#186340` | `#2E8A5B` | Primary hover/pressed |
| `--brand-900` | `#0D3A26` | `#D6F0E1` | Headings on brand surfaces |
| `--surface` | `#FFFFFF` | `#0F1512` | Card and page ground |
| `--surface-muted` | `#F6F8F7` | `#161D19` | App background |
| `--border` | `#E2E8E5` | `#26312C` | Hairlines |
| `--text` | `#12211A` | `#E8EFEA` | Body text |
| `--text-muted` | `#5C6B64` | `#9AAAA2` | Secondary text, n and period labels |

### 2.2 Clinical data palette (semantic)

Chosen for clinical convention and clarity, not brand harmony. That susceptible
happens to land near the brand green is a coincidence to be tolerated, not a
principle to be extended.

| Token | Light | Dark | Meaning |
|---|---|---|---|
| `--sir-s` | `#1B8A5A` | `#3FB07F` | Susceptible |
| `--sir-i` | `#C77800` | `#E0A030` | Intermediate / susceptible-dose-dependent |
| `--sir-r` | `#C2352B` | `#E06A5E` | Resistant |
| `--sir-nt` | `#8A9793` | `#6E7C77` | Not tested / not reported |
| `--insufficient` | `#EDEFEE` fill, `#6B7873` hatch | `#1C2420` fill, `#7C8A84` hatch | Below threshold or suppressed |

Red/green colour blindness affects roughly one man in twelve, which in a clinical
audience is a certainty and not an edge case. **Colour is never the sole encoding.**
Every S/I/R cell also carries its letter, and the "insufficient data" state carries a
distinct diagonal-hatch texture as well as its own fill.

### 2.3 Categorical palette (multi-series charts)

For charts plotting several organisms or facilities together, where the series
carry no S/I/R meaning. Deliberately distinct from both palettes above so a
multi-series line is never mistaken for a severity encoding.

`#2E5EAA` `#B5651D` `#6A4C93` `#0F8B8D` `#A03E70` `#7A6C0A` `#3E7C4F` `#8C4A2F`

### 2.4 Severity scale (heat maps, resistance-rate choropleths)

Sequential single-hue ramp toward red, with `--insufficient` reserved for
below-threshold geography. A district with no data must never render as a low-
resistance colour.

`#F7EDEA` `#EFCEC7` `#E3A79C` `#D47D70` `#C2564A` `#A33529` `#7D1F16`

## 3. Non-negotiable display rules

These are correctness requirements, not styling preferences. Component APIs are
designed so that violating them is difficult.

1. **No bare percentage, ever.** Every susceptibility figure renders with its `n`
   and its data period adjacent. The `<Statistic>` component requires both props.
2. **Data-freshness banner on every analytical view** — last updated, coverage
   period, contributing facilities, latest submission, completeness.
3. **Suppressed and below-threshold cells** render in the dedicated
   "insufficient data" state — never as `0%`, never as blank, never omitted from the
   table.
4. **"How was this calculated?"** is available on every antibiogram and statistic.
5. **Persistent, non-dismissible framing** on any page showing susceptibility data:
   *"Susceptibility data reflect regional surveillance patterns and support clinical
   decision-making; they do not replace individualized clinical judgment."*
6. **Signals are labelled as signals.** Emerging-resistance findings read "Signal —
   requires expert review". The word "outbreak" does not appear as a system claim.
7. **Excluded facilities are visible.** Where QC/EQA gating removes a facility from
   the verified aggregate, the view says how many and which — never a silent omission.

## 4. Typography and layout

- System sans-serif stack; no custom webfont to fetch on a facility connection.
- Type scale: 12 / 14 / 16 / 20 / 24 / 32 px. Body 16, table and metadata 14,
  `n`/period annotations 12 in `--text-muted`.
- Tabular figures (`font-variant-numeric: tabular-nums`) on every number in a table
  so columns of percentages align on the decimal.
- 8px spacing grid. Cards: 12px radius, 1px `--border`, shadow no heavier than
  `0 1px 2px rgba(0,0,0,.04)`.
- Content maximum 1440px; antibiogram tables scroll horizontally inside their own
  container so the page body never scrolls sideways.

## 5. Accessibility

- WCAG 2.1 AA: 4.5:1 for text, 3:1 for UI boundaries and chart marks. Every pair
  above is verified at those ratios against its own background.
- Visible focus ring on every interactive element, `--brand-600` at 2px offset.
- Antibiogram tables use real `<table>` semantics with scoped headers, so a screen
  reader announces "Escherichia coli, Ciprofloxacin, 64 percent susceptible, n 212".
- Full keyboard operability. No hover-only disclosure of information.
- Targets 44×44px minimum — facility computers frequently have imprecise mice.

## 6. Performance on facility hardware

Shared facility computers on modest bandwidth are the design target, not an
afterthought. Heavy views degrade to cached last-known aggregates with a clearly
labelled staleness notice rather than failing outright. No view requires more than
one blocking request before showing structure.
