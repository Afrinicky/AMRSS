"use client";

import { useId, useState } from "react";

/**
 * A password input with a show/hide toggle.
 *
 * The forms around it are server-action forms carrying no client JavaScript, so
 * the input itself needs none — but revealing what you typed is a client-only
 * concern (the value never has to leave the field to be shown), which is exactly
 * what this small island provides. It stays a plain `<input name=…>` so the
 * enclosing server action reads it unchanged.
 *
 * The toggle is a real button, keyboard reachable, and announces its state with
 * `aria-pressed`; the field's type flips between `password` and `text` so a
 * password manager still recognises it while hidden.
 */
export function PasswordField({
  name,
  id,
  required,
  minLength,
  autoComplete = "current-password",
  defaultValue,
  className,
  describedBy,
}: {
  name: string;
  id?: string;
  required?: boolean;
  minLength?: number;
  autoComplete?: string;
  defaultValue?: string;
  className?: string;
  describedBy?: string;
}) {
  const [shown, setShown] = useState(false);
  const fallbackId = useId();
  const fieldId = id ?? fallbackId;

  return (
    <div className="relative">
      <input
        id={fieldId}
        name={name}
        type={shown ? "text" : "password"}
        required={required}
        minLength={minLength}
        autoComplete={autoComplete}
        defaultValue={defaultValue}
        aria-describedby={describedBy}
        className={`${className ?? ""} pr-16`}
      />
      <button
        type="button"
        onClick={() => setShown((value) => !value)}
        aria-pressed={shown}
        className="absolute inset-y-0 right-0 my-1 mr-1 rounded-md px-2 text-xs font-medium text-ink-muted hover:bg-surface-muted hover:text-ink"
      >
        {shown ? "Hide" : "Show"}
      </button>
    </div>
  );
}
