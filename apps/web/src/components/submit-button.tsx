"use client";

import { useFormStatus } from "react-dom";

/**
 * A submit button that says so while the server action is still running.
 *
 * Sign-in is where this matters most. It is the one action whose whole cost is
 * a call to the surveillance API, and if that API has been asleep the call
 * takes about a minute — during which an unchanged button is indistinguishable
 * from a click that did not register, so people click it again.
 *
 * `useFormStatus` reads the pending state of the enclosing form, which is why
 * this is a separate component: the hook reports on the form above it, so it
 * cannot live in the same component as the <form> itself.
 */
export function SubmitButton({
  children,
  pendingLabel,
  className,
}: {
  children: React.ReactNode;
  pendingLabel: string;
  className?: string;
}) {
  const { pending } = useFormStatus();

  return (
    <button type="submit" disabled={pending} aria-disabled={pending} className={className}>
      <span aria-live="polite">{pending ? pendingLabel : children}</span>
    </button>
  );
}
