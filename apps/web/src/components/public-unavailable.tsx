import { PublicShell } from "@/components/public-shell";

/**
 * What a public page shows when the surveillance service could not be reached
 * while the page was being generated.
 *
 * The public pages are pre-rendered and cached, so this is rare — it happens
 * only if the backend was down at the moment a page was (re)built. It exists so
 * that moment degrades to a calm "check back shortly" rather than failing the
 * whole deployment, and so the page heals itself on the next revalidation once
 * the service answers again.
 */
export function PublicUnavailable({ current }: { current: string }) {
  return (
    <PublicShell current={current}>
      <div className="mx-auto max-w-md py-16 text-center">
        <h1 className="text-lg font-semibold text-ink">Figures are being prepared</h1>
        <p className="mt-2 text-sm text-ink-muted">
          The surveillance figures could not be loaded just now. This page refreshes itself
          shortly — please check back in a little while.
        </p>
      </div>
    </PublicShell>
  );
}
