/**
 * Components that make the SDD 11.3 display rules structural.
 *
 * `Statistic` requires `n` and `period` as props. A developer cannot render a
 * bare percentage through this component without the type checker objecting,
 * which is the point: the rule is enforced by the API shape and again here,
 * rather than relying on every future contributor remembering it.
 */

import type { Cell, CellState } from "@/lib/api";

export function Statistic({
  value,
  n,
  period,
  interval,
  uncertain = false,
  size = "medium",
}: {
  value: number;
  /** Interpretable isolate count. Required — a percentage without it is not a
   * statistic. */
  n: number;
  /** Human-readable data period. Required, for the same reason. */
  period: string;
  interval?: { lower: number; upper: number } | null;
  uncertain?: boolean;
  size?: "medium" | "large";
}) {
  return (
    <div>
      <div
        className={`tabular font-semibold text-ink ${
          size === "large" ? "text-3xl" : "text-xl"
        }`}
      >
        {value.toFixed(1)}%
        <span className="ml-1 text-sm font-normal text-ink-muted">susceptible</span>
      </div>
      <div className="tabular mt-1 text-xs text-ink-muted">
        n = {n.toLocaleString()}
        {interval ? ` · 95% CI ${interval.lower.toFixed(1)}–${interval.upper.toFixed(1)}%` : ""}
        {" · "}
        {period}
      </div>
      {uncertain ? (
        <div className="mt-1 text-xs text-sir-i">
          Modest isolate count — interpret the interval, not the point estimate.
        </div>
      ) : null}
    </div>
  );
}

const STATE_LABEL: Record<Exclude<CellState, "reportable">, string> = {
  below_threshold: "Insufficient data",
  suppressed: "Withheld",
  not_tested: "Not tested",
};

const STATE_EXPLANATION: Record<Exclude<CellState, "reportable">, string> = {
  below_threshold:
    "Fewer isolates than the reporting threshold requires. No percentage is shown because one would not be reliable.",
  suppressed:
    "Withheld in cross-facility views to prevent identification of individuals from a small number of isolates.",
  not_tested: "This agent was not tested against this organism in the selected population.",
};

/** One antibiogram cell.
 *
 * Colour is never the only encoding: every reportable cell also carries its
 * numeric value, and the insufficient-data state carries a hatch texture. Red
 * and green are indistinguishable to a meaningful share of any clinical
 * audience. */
export function SirCell({ cell, period }: { cell: Cell; period: string }) {
  if (cell.state !== "reportable") {
    const state = cell.state;
    return (
      <td
        className="insufficient-fill border border-line px-2 py-1.5 text-center align-middle"
        title={STATE_EXPLANATION[state]}
      >
        <span className="text-[11px] font-medium text-insufficient-ink">
          {STATE_LABEL[state]}
        </span>
      </td>
    );
  }

  const percent = cell.susceptible_percent ?? 0;
  const tint =
    percent >= 70
      ? "color-mix(in srgb, var(--color-sir-s) 16%, transparent)"
      : percent >= 50
        ? "color-mix(in srgb, var(--color-sir-i) 16%, transparent)"
        : "color-mix(in srgb, var(--color-sir-r) 16%, transparent)";
  const ink =
    percent >= 70 ? "var(--color-sir-s)" : percent >= 50 ? "var(--color-sir-i)" : "var(--color-sir-r)";

  return (
    <td
      className="border border-line px-2 py-1.5 text-center align-middle"
      style={{ backgroundColor: tint }}
      title={`${percent.toFixed(1)}% susceptible, n = ${cell.interpretable} interpretable of ${cell.tested} tested, ${period}`}
    >
      <span className="tabular text-sm font-semibold" style={{ color: ink }}>
        {percent.toFixed(0)}
        <span className="text-[10px] font-normal">%</span>
      </span>
      <span className="tabular block text-[10px] leading-tight text-ink-muted">
        n={cell.interpretable}
        {cell.uncertainty_cue ? " ·  ~" : ""}
      </span>
    </td>
  );
}

export function StatTile({
  label,
  value,
  detail,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  detail?: string;
  /** `attention` is the only tone that carries meaning; the rest is chrome. */
  tone?: "neutral" | "brand" | "attention";
}) {
  const brand = tone === "brand";
  return (
    <div
      className={`rounded-[--radius-card] border p-4 ${
        brand ? "border-brand-300/60 brand-soft" : "border-line bg-surface"
      }`}
    >
      <div
        className={`text-xs font-medium uppercase tracking-wide ${
          brand ? "text-brand-700" : "text-ink-muted"
        }`}
      >
        {label}
      </div>
      <div
        className={`tabular mt-1.5 text-2xl font-semibold ${
          tone === "attention" ? "text-sir-i" : brand ? "text-brand-900" : "text-ink"
        }`}
      >
        {value}
      </div>
      {detail ? (
        <div className={`mt-1 text-xs ${brand ? "text-brand-700/80" : "text-ink-muted"}`}>
          {detail}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Radial gauge for a genuine proportion of a whole — coverage, completeness,
 * reporting compliance.
 *
 * Deliberately not used for susceptibility. A ring invites reading as
 * "how full is this", which is the wrong mental model for a rate that must be
 * read together with its n and time period. Those stay in the antibiogram.
 */
export function Ring({
  value,
  caption,
  sublabel,
  size = 84,
  tone = "brand",
}: {
  value: number;
  caption: string;
  sublabel?: string;
  size?: number;
  tone?: "brand" | "on-brand";
}) {
  const bounded = Math.max(0, Math.min(100, value));
  const colour = tone === "on-brand" ? "var(--color-on-brand)" : "var(--color-brand-600)";

  return (
    <figure className="flex items-center gap-3">
      <div
        className="relative shrink-0"
        style={{ width: size, height: size, color: colour }}
        role="img"
        aria-label={`${caption}: ${bounded.toFixed(0)} percent`}
      >
        <div className="ring-ticks" aria-hidden />
        <div
          className="ring"
          aria-hidden
          style={
            {
              "--ring-value": bounded,
              "--ring-colour": colour,
              "--ring-size": `${size}px`,
            } as React.CSSProperties
          }
        />
        <div className="absolute inset-0 grid place-items-center">
          <span
            className="tabular text-lg font-semibold"
            style={{ color: tone === "on-brand" ? "var(--color-on-brand)" : "var(--color-brand-900)" }}
          >
            {bounded.toFixed(0)}
            <span className="text-[11px] font-normal">%</span>
          </span>
        </div>
      </div>
      <figcaption>
        <div
          className={`text-sm font-medium ${
            tone === "on-brand" ? "text-on-brand" : "text-ink"
          }`}
        >
          {caption}
        </div>
        {sublabel ? (
          <div
            className={`text-xs ${
              tone === "on-brand" ? "text-on-brand-muted" : "text-ink-muted"
            }`}
          >
            {sublabel}
          </div>
        ) : null}
      </figcaption>
    </figure>
  );
}
