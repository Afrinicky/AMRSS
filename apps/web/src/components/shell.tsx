import Link from "next/link";

import type { Profile } from "@/lib/api";

/** Navigation is filtered by permission, but the API enforces access
 * independently. Hiding a link is a courtesy to the user, never a control —
 * SDD 7 requires enforcement at the API layer. */
const NAV = [
  { href: "/", label: "Overview", permission: null },
  { href: "/antibiogram", label: "Antibiogram", permission: null },
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

      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-8 gap-y-3 px-6 py-3">
          <Link href="/" className="flex items-baseline gap-2">
            <span className="text-lg font-semibold tracking-tight text-brand-700">AMRSS</span>
            <span className="hidden text-xs text-ink-muted sm:inline">
              Antimicrobial Resistance Surveillance System
            </span>
          </Link>

          <nav aria-label="Main" className="flex flex-1 flex-wrap gap-1">
            {visible.map((item) => {
              const active = item.href === current;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                    active
                      ? "bg-brand-50 text-brand-700"
                      : "text-ink-muted hover:bg-surface-muted hover:text-ink"
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="flex items-center gap-3 text-right">
            <div className="hidden sm:block">
              <div className="text-sm font-medium text-ink">{profile.full_name}</div>
              <div className="text-xs text-ink-muted">
                {ROLE_LABELS[profile.role] ?? profile.role}
              </div>
            </div>
            <form action="/api/signout" method="post">
              <button
                type="submit"
                className="rounded-lg border border-line px-3 py-2 text-sm text-ink-muted hover:bg-surface-muted hover:text-ink"
              >
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-[1440px] px-6 py-8">
        {children}
      </main>

      <footer className="mx-auto max-w-[1440px] px-6 pb-10 text-xs text-ink-muted">
        AMRSS reports surveillance intelligence, not prescribing advice. Figures reflect
        de-identified data submitted by participating laboratories.
      </footer>
    </div>
  );
}

export function PageHeading({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <div className="mb-6">
      <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
      {description ? <p className="mt-1 max-w-3xl text-sm text-ink-muted">{description}</p> : null}
    </div>
  );
}
