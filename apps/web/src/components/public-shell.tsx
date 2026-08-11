import Link from "next/link";

/**
 * The frame around every public page.
 *
 * Deliberately lighter than the signed-in console's shell: there is no account,
 * no permission-filtered navigation, and one call to action — sign in — because
 * the people who do more than read are the ones who have a login. The tabs move
 * between the aggregate views anyone may see.
 */

const PUBLIC_NAV = [
  { href: "/", label: "Overview" },
  { href: "/empiric", label: "Empiric guidance" },
  { href: "/antibiogram", label: "Antibiogram" },
  { href: "/organisms", label: "Organisms" },
  { href: "/antibiotics", label: "Antibiotics" },
  { href: "/specimens", label: "Specimens" },
];

export function PublicShell({
  current,
  children,
}: {
  current: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-surface focus:px-3 focus:py-2 focus:text-sm"
      >
        Skip to content
      </a>

      <header className="brand-gradient brand-edge-bottom culture-field">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-8 gap-y-3 px-4 py-3 sm:px-6">
          <Link href="/" className="order-1 flex items-center gap-2.5">
            <CultureMark />
            <span className="flex items-baseline gap-2">
              <span className="text-lg font-semibold tracking-tight text-on-brand">
                AMR<span className="accent-text">SS</span>
              </span>
              <span className="hidden text-xs text-on-brand-muted sm:inline">
                Antimicrobial Resistance Surveillance
              </span>
            </span>
          </Link>

          <nav
            aria-label="Main"
            className="scroll-row order-3 -mx-1 flex w-full gap-1 overflow-x-auto px-1 lg:order-2 lg:mx-0 lg:w-auto lg:flex-1 lg:px-0"
          >
            {PUBLIC_NAV.map((item) => {
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

          <div className="order-2 ml-auto lg:order-3">
            <Link
              href="/console"
              className="rounded-lg border border-white/25 px-3 py-2 text-sm font-medium text-on-brand transition-colors hover:bg-white/10"
            >
              Sign in
            </Link>
          </div>
        </div>
      </header>

      <main id="main" className="mx-auto max-w-[1440px] px-4 py-8 sm:px-6">
        {children}
      </main>

      <footer className="mx-auto max-w-[1440px] px-4 py-8 text-xs text-ink-muted sm:px-6">
        <p className="border-t border-line pt-4">
          Figures are the regional aggregate: pooled across contributing laboratories, with
          combinations below the reporting threshold withheld and only quality-verified
          laboratories counted. They describe surveillance, not an individual result, and are not
          a prescribing guide. Access to facility-level data and administration is through{" "}
          <Link href="/console" className="text-brand-700 underline">
            sign in
          </Link>
          .
        </p>
      </footer>
    </div>
  );
}

/** The culture-plate mark, matching the console's, so the two halves read as one
 *  system. Kept local to avoid the public bundle importing the console shell. */
function CultureMark() {
  return (
    <span
      aria-hidden
      className="flex h-7 w-7 items-center justify-center rounded-full bg-white/15 ring-1 ring-white/25"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="9" stroke="var(--color-accent)" strokeWidth="2" />
        <circle cx="9.5" cy="10" r="1.6" fill="var(--color-accent)" />
        <circle cx="14.5" cy="11.5" r="1.2" fill="var(--color-accent)" />
        <circle cx="11" cy="14.5" r="1" fill="var(--color-accent)" />
      </svg>
    </span>
  );
}
