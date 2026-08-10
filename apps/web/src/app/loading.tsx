/**
 * What every page shows while its data is still in flight.
 *
 * One file at the application root covers every route: Next.js renders it for
 * whichever segment is loading, so a page added later inherits this without
 * knowing it exists.
 *
 * It matters more here than on an ordinary dashboard. Every page renders on the
 * server and waits for the surveillance API before it can render anything at
 * all, so without this the browser holds the *previous* screen — or a blank one
 * on first load — for the whole wait. On a container that has just woken from
 * sleep, that is a minute of a system that appears to have died.
 *
 * The shape below is the application's own chrome, not a generic spinner, so
 * the wait looks like the dashboard arriving rather than something else
 * happening first.
 */
export default function Loading() {
  return (
    <div className="min-h-screen" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading surveillance data</span>

      {/* The real header is a server component needing a signed-in profile,
          which is precisely what is not available yet. This mirrors its
          geometry — brand left, navigation row, account right — so the header
          does not visibly change height or colour when it replaces this. */}
      <header className="brand-gradient brand-edge-bottom culture-field" aria-hidden>
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center gap-x-8 gap-y-3 px-4 py-3 sm:px-6">
          <div className="order-1 flex items-center gap-2.5">
            <div className="skeleton-on-brand h-7 w-7 rounded-full" />
            <span className="text-lg font-semibold tracking-tight text-on-brand">
              AMR<span className="accent-text">SS</span>
            </span>
          </div>

          <div className="order-3 -mx-1 flex w-full gap-2 px-1 lg:order-2 lg:mx-0 lg:w-auto lg:flex-1 lg:px-0">
            {[68, 84, 76, 80, 74, 62].map((width, index) => (
              <div
                key={index}
                className="skeleton-on-brand h-7 shrink-0"
                style={{ width: `${width}px` }}
              />
            ))}
          </div>

          <div className="order-2 ml-auto lg:order-3">
            <div className="skeleton-on-brand h-7 w-28" />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1440px] px-4 py-6 sm:px-6">
        <div className="space-y-6">
          {/* The hero band, which on most pages is the tallest thing above the
              fold. Reserving its height is what stops the page jumping. */}
          <div className="skeleton h-44 w-full rounded-[--radius-card]" />

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }, (_, index) => (
              <div
                key={index}
                className="rounded-[--radius-card] border border-line bg-surface p-4"
              >
                <div className="skeleton h-4 w-2/3" />
                <div className="skeleton mt-2 h-3 w-1/3" />
                <div className="mt-4 space-y-2 border-t border-line pt-3">
                  <div className="skeleton h-3 w-full" />
                  <div className="skeleton h-3 w-5/6" />
                  <div className="skeleton h-3 w-4/6" />
                </div>
              </div>
            ))}
          </div>

          {/* Appears six seconds in, and only then. A normal load never shows
              it; showing it every time would teach people the system is slow
              when it is not. Hidden from assistive technology because the
              "Loading surveillance data" announcement above already covers
              this, and a live region that speaks twice is worse than one that
              speaks once. */}
          <p className="reveal-late text-sm text-ink-muted" aria-hidden>
            Still working. After a quiet period the surveillance service takes about a minute
            to wake — this page will load itself as soon as it answers.
          </p>
        </div>
      </main>
    </div>
  );
}
