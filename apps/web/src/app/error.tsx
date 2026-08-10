"use client";

import { useEffect, useRef, useState } from "react";

/**
 * What a page shows when rendering it threw.
 *
 * The dominant cause in this deployment is not a defect: the surveillance API
 * is a container that sleeps after fifteen minutes of inactivity, and a request
 * that arrives during the wake can outlast the render budget. That case fixes
 * itself — the service is awake by the time anyone tries again.
 *
 * So this page retries once on its own before asking a human to do anything.
 * What it must not do is claim to know which case it is in. Next.js redacts
 * server error messages before they reach the browser, deliberately, so all
 * this component actually knows is that something failed. The wording below
 * says that, and offers the waking service as the likely explanation rather
 * than the established one.
 */

/** Long enough for a container mid-wake to finish, short enough to feel like
 * the page recovering rather than a second wait. */
const AUTO_RETRY_DELAY_MS = 4000;

/** How long an automatic retry is remembered, so a page that fails repeatedly
 * settles into asking rather than reloading itself forever. Keyed per path:
 * failing on one page says nothing about the next. */
const AUTO_RETRY_COOLDOWN_MS = 120_000;

function mayAutoRetry(path: string): boolean {
  try {
    const key = `amrss:auto-retry:${path}`;
    const previous = Number(sessionStorage.getItem(key) ?? 0);
    if (Date.now() - previous < AUTO_RETRY_COOLDOWN_MS) return false;
    sessionStorage.setItem(key, String(Date.now()));
    return true;
  } catch {
    // Private browsing and blocked storage both throw here. Losing the guard
    // must not cost the retry, but it must not risk a loop either — so the
    // safe answer when we cannot remember is to not retry automatically.
    return false;
  }
}

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [retrying, setRetrying] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    // Guarded against React's development double-invocation, which would
    // otherwise spend the one permitted retry before the delay elapsed.
    if (started.current) return;
    started.current = true;

    if (!mayAutoRetry(window.location.pathname)) return;

    setRetrying(true);
    const timer = setTimeout(reset, AUTO_RETRY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [reset]);

  return (
    <div className="flex min-h-screen items-center justify-center px-6 py-12">
      <div className="w-full max-w-md" role="alert">
        <div className="rounded-[--radius-card] border border-line bg-surface p-6">
          <div className="text-lg font-semibold tracking-tight text-brand-700">
            AMR<span className="accent-text">SS</span>
          </div>

          <h1 className="mt-4 text-base font-semibold text-ink">This page could not be loaded</h1>

          <p className="mt-2 text-sm text-ink-muted">
            The dashboard could not get an answer from the surveillance service. The usual
            reason is that the service had gone to sleep after a quiet period and is still
            waking, which takes about a minute and needs nothing from you.
          </p>

          {retrying ? (
            <p className="mt-4 flex items-center gap-2 text-sm text-ink" aria-live="polite">
              <span
                aria-hidden
                className="h-3 w-3 shrink-0 animate-pulse rounded-full bg-brand-600"
              />
              Trying again…
            </p>
          ) : (
            <button
              type="button"
              onClick={reset}
              className="mt-4 w-full rounded-lg bg-brand-600 px-3 py-2 text-sm font-medium text-on-brand"
            >
              Try again
            </button>
          )}

          <p className="mt-4 border-t border-line pt-4 text-xs text-ink-muted">
            If it keeps failing, the service may genuinely be down rather than asleep. Quote
            this reference when reporting it:{" "}
            <code className="tabular text-ink">{error.digest ?? "none recorded"}</code>
          </p>
        </div>
      </div>
    </div>
  );
}
