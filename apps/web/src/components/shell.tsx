import Link from "next/link";

import type { Profile } from "@/lib/api";

/** Navigation is filtered by permission, but the API enforces access
 * independently. Hiding a link is a courtesy to the user, never a control —
 * SDD 7 requires enforcement at the API layer. */
const NAV = [
  { href: "/", label: "Overview", permission: null },
  { href: "/antibiogram", label: "Antibiogram", permission: null },
  { href: "/organisms", label: "Organisms", permission: null },
  { href: "/antibiotics", label: "Antibiotics", permission: null },
  { href: "/specimens", label: "Specimens", permission: null },
  { href: "/alerts", label: "Alerts & signals", permission: null },
  { href: "/coverage", label: "Coverage", permission: "surveillance:view_regional" },
];

const ROLE_LABELS: Record<string, string> = {
  clinician: "Clinician",
  laboratory_staff: "Laboratory staff",
  facility_administrator: "Facility administrator",
  data_steward: "Data steward",
  regional_amr_administrator: "Regional AMR administrator",
  auditor: "Auditor",
  system_administrator: "System administrator",
};

export function Shell({
  profile,
  current,
  children,
}: {
  profile: Profile;
  current: string;
  children: React.ReactNode;
}) {
  const visible = NAV.filter(
    (item) => item.permission === null || profile.permissions.includes(item.permission),
  );

  return (
    <div className="min-h-screen">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2 focus:text-sm"
      >
        Skip to content
      </a>

      {/* The header carries the brand green rather than sitting white on white.
          It is chrome only — no clinical value is ever encoded in it.

          Below `lg`, the seven navigation entries would stack into a column
          taller than the first screenful of content, so the row reorders: brand
          and account sit on one line and the navigation becomes a single
          horizontally scrollable row beneath them. `order` does the reordering
          rather than duplicated markup, so there is one nav in the accessibility
          tree, not two. */}
      <header className="brand-gradient brand-edge-bottom culture-field">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-8 gap-y-3 px-4 py-3 sm:px-6">
          <Link href="/" className="order-1 flex items-center gap-2.5">
            <CultureMark />
            <span className="flex items-baseline gap-2">
              <span className="text-lg font-semibold tracking-tight text-on-brand">
                AMR<span className="accent-text">SS</span>
              </span>
              {/* The spelled-out name only appears once there is room for it
                  beside a full navigation row; below that it pushed "Coverage"
                  onto a second line on its own. */}
              <span className="hidden text-xs text-on-brand-muted 2xl:inline">
                Antimicrobial Resistance Surveillance
              </span>
            </span>
          </Link>

          <nav
            aria-label="Main"
            className="scroll-row order-3 -mx-1 flex w-full gap-1 overflow-x-auto px-1 lg:order-2 lg:mx-0 lg:w-auto lg:flex-1 lg:flex-wrap lg:overflow-visible lg:px-0"
          >
            {visible.map((item) => {
              const active = item.href === current;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`shrink-0 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                    active
                      ? "bg-white/15 text-on-brand shadow-[inset_0_-2px_0_0_var(--color-accent)]"
                      : "text-on-brand-muted hover:bg-white/10 hover:text-on-brand"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="order-2 ml-auto flex items-center gap-3 text-right lg:order-3 lg:ml-0">
            <div className="hidden sm:block">
              <div className="text-sm font-medium text-on-brand">{profile.full_name}</div>
              <div className="text-xs text-on-brand-muted">
                {ROLE_LABELS[profile.role] ?? profile.role}
              </div>
            </div>
            <form action="/api/signout" method="post">
              <button
                type="submit"
                className="rounded-lg border border-white/25 px-3 py-2 text-sm text-on-brand-muted transition-colors hover:bg-white/10 hover:text-on-brand"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-[1440px] px-4 py-8 sm:px-6">
        {children}
      </main>

      <footer className="brand-gradient brand-edge-top culture-field mt-4">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-4 px-4 py-5 sm:px-6">
          <div className="flex items-center gap-2.5">
            <CultureMark />
            <div>
              <div className="text-sm font-semibold text-on-brand">
                AMR<span className="accent-text">SS</span>
              </div>
              <div className="text-xs text-on-brand-muted">
                Antimicrobial Resistance Surveillance System
              </div>
            </div>
          </div>
          <p className="max-w-xl text-xs text-on-brand-muted">
            AMRSS reports surveillance intelligence, not prescribing advice. Figures reflect
            de-identified data submitted by participating laboratories.
          </p>
        </div>
      </footer>
    </div>
  );
}

/**
 * The product mark: a culture plate with colonies and an inhibition zone — the
 * disk-diffusion image this whole system is built around. It gives the interface
 * a domain identity that a generic chart icon would not, without decorating any
 * clinical figure.
 */
export function CultureMark({ className = "size-7" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} role="img" aria-label="AMRSS">
      <circle cx="16" cy="16" r="14" fill="currentColor" opacity="0.14" />
      <circle cx="16" cy="16" r="14" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.55" />
      {/* The antimicrobial disk and its zone of inhibition. */}
      <circle
        cx="16"
        cy="16"
        r="6.5"
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth="1"
        strokeDasharray="2 2"
        opacity="0.85"
      />
      <circle cx="16" cy="16" r="2.6" fill="var(--color-accent)" />
      {/* Colonies growing beyond the zone edge. */}
      <circle cx="8.4" cy="10.5" r="1.5" fill="currentColor" opacity="0.75" />
      <circle cx="24" cy="11.5" r="1.2" fill="currentColor" opacity="0.6" />
      <circle cx="9.5" cy="22.5" r="1.3" fill="currentColor" opacity="0.65" />
      <circle cx="23" cy="22" r="1.6" fill="currentColor" opacity="0.7" />
    </svg>
  );
}

/**
 * Green page banner, matching the overview hero so every view is framed the same
 * way. Chrome only: the aside slot takes counts and context, never a
 * susceptibility figure — those belong in the antibiogram with their n and
 * period attached.
 */
export function PageHeading({
  title,
  description,
  aside,
}: {
  title: string;
  description?: string;
  aside?: React.ReactNode;
}) {
  return (
    <section className="brand-gradient brand-edge-bottom culture-field mb-6 overflow-hidden rounded-[--radius-card]">
      <div className="flex flex-wrap items-center justify-between gap-6 px-4 py-5 sm:px-6">
        <div className="min-w-[16rem] flex-1">
          <h1 className="text-2xl font-semibold tracking-tight text-on-brand">{title}</h1>
          {description ? (
            <p className="mt-1.5 max-w-3xl text-sm text-on-brand-muted">{description}</p>
          ) : null}
        </div>
        {aside ? <div className="flex flex-wrap items-center gap-4">{aside}</div> : null}
      </div>
    </section>
  );
}

/** A figure on a green banner. */
export function BannerFigure({
  label,
  value,
  detail,
}: {
  label: string;
  value: string | number;
  detail?: string;
}) {
  return (
    <div className="rounded-xl border border-white/20 bg-white/10 px-4 py-3">
      <div className="accent-text text-xs font-medium uppercase tracking-wide">{label}</div>
      <div className="tabular mt-1 text-2xl font-semibold text-on-brand">{value}</div>
      {detail ? <div className="text-xs text-on-brand-muted">{detail}</div> : null}
    </div>
  );
}
