/**
 * Shared pieces of the administration console.
 *
 * Status here is administrative, not clinical, so it uses the neutral chrome
 * palette rather than the S/I/R one. A suspended facility drawn in the Resistant
 * red would read as a resistance finding to anyone glancing at the page — the
 * two vocabularies must not borrow each other's colours (DESIGN_LANGUAGE.md).
 */

import type { FacilityStatus } from "@/lib/api";

const STATUS_STYLE: Record<FacilityStatus, string> = {
  pending: "border-line bg-surface-muted text-ink-muted",
  under_verification: "border-accent-strong/40 bg-accent/15 text-ink",
  active: "border-brand-600/40 bg-brand-600/10 text-brand-700",
  suspended: "border-accent-strong/50 bg-accent-strong/15 text-ink",
  inactive: "border-line bg-surface-muted text-ink-muted",
  retired: "border-line bg-surface-muted text-ink-muted",
};

export const STATUS_LABEL: Record<FacilityStatus, string> = {
  pending: "Pending",
  under_verification: "Under verification",
  active: "Active",
  suspended: "Suspended",
  inactive: "Inactive",
  retired: "Retired",
};

export function StatusPill({ status }: { status: FacilityStatus }) {
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium ${STATUS_STYLE[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

/** A labelled figure on the admin surface. */
export function AdminStat({
  label,
  value,
  detail,
  emphasis = false,
}: {
  label: string;
  value: string | number;
  detail?: string;
  /** Draws attention without implying severity: gold, never clinical red. */
  emphasis?: boolean;
}) {
  return (
    <div
      className={`rounded-[--radius-card] border bg-surface p-4 ${
        emphasis ? "border-accent-strong/45" : "border-line"
      }`}
    >
      <div className="text-xs font-medium uppercase tracking-wide text-ink-muted">{label}</div>
      <div
        className={`tabular mt-1 text-2xl font-semibold ${
          emphasis ? "text-accent-strong" : "text-ink"
        }`}
      >
        {value}
      </div>
      {detail ? <div className="mt-0.5 text-xs text-ink-muted">{detail}</div> : null}
    </div>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-[--radius-card] border border-line bg-surface px-4 py-8 text-center text-sm text-ink-muted">
      {children}
    </p>
  );
}

/**
 * A table that scrolls inside its own container.
 *
 * Admin tables run wide and are read on shared facility machines. Letting the
 * page body scroll sideways instead would drag the navigation off screen.
 */
export function ScrollTable({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-[--radius-card] border border-line bg-surface">
      <table className="banded w-full text-sm">{children}</table>
    </div>
  );
}

export function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function formatDateTime(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
