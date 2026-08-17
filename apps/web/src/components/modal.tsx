"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * A dialog that opens over the page, so managing one record no longer scrolls
 * the list away beneath a long inline panel.
 *
 * Built on the native `<dialog>` element deliberately: `showModal()` gives a
 * focus trap, Escape-to-close and an inert background for free, which a
 * hand-rolled overlay gets wrong more often than right. The trigger and the
 * dialog body are the only custom parts.
 *
 * The body is server-rendered content — the same forms with their server
 * actions — passed as children. Submitting one runs the action and navigates, so
 * the dialog simply goes away with the re-render; there is no client state to
 * keep in sync.
 */
export function Modal({
  label,
  triggerLabel,
  triggerClassName,
  title,
  children,
}: {
  /** Accessible name for the dialog. */
  label: string;
  /** What the opening control reads. */
  triggerLabel: ReactNode;
  triggerClassName?: string;
  /** Visible heading inside the dialog. Defaults to `label`. */
  title?: ReactNode;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  // Restore page scrolling if the dialog is unmounted while open.
  useEffect(() => {
    const dialog = ref.current;
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);

  const close = () => ref.current?.close();

  return (
    <>
      <button
        type="button"
        onClick={() => ref.current?.showModal()}
        className={triggerClassName ?? "text-left text-brand-700 hover:underline"}
      >
        {triggerLabel}
      </button>

      <dialog
        ref={ref}
        aria-label={label}
        // Clicking the backdrop (the dialog element itself, outside the inner
        // panel) closes it; clicks inside the panel do not bubble to here.
        onClick={(event) => {
          if (event.target === ref.current) close();
        }}
        className="w-[min(44rem,92vw)] max-w-none rounded-[--radius-card] border border-line bg-surface p-0 text-ink shadow-xl backdrop:bg-black/40"
      >
        <div className="flex items-center justify-between gap-4 border-b border-line px-5 py-3">
          <h2 className="text-base font-semibold text-ink">{title ?? label}</h2>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="rounded-md px-2 py-1 text-lg leading-none text-ink-muted hover:bg-surface-muted hover:text-ink"
          >
            ×
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
      </dialog>
    </>
  );
}
