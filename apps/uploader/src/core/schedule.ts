/**
 * When the uploader sends, if nobody clicks anything.
 *
 * Two modes, and the choice belongs to the facility:
 *
 * - **Manual.** Nothing leaves without someone pressing send. The default, and
 *   the right answer for a laboratory that reviews every batch.
 * - **Automatic.** The uploader sends on a schedule the facility configures —
 *   the same shape as a scheduled backup: how often, at what time, on which day.
 *
 * Automatic is not unattended. An automatic run still refuses to send a batch
 * that has not passed validation, and — where the facility asks for it — one
 * that a person has not signed off since the data last changed. That is the
 * point of `requireValidatedSignOff`: WHONET is still being typed into while
 * this software watches the file, and a schedule that fires mid-entry would
 * otherwise upload a half-entered specimen. What the schedule automates is the
 * *sending*, never the *checking*.
 */

export type ScheduleFrequency = "hourly" | "daily" | "weekly" | "monthly" | "interval";

export interface SyncSchedule {
  mode: "manual" | "automatic";
  frequency: ScheduleFrequency;
  /** 24-hour local time, "HH:MM". Used by daily, weekly and monthly. */
  timeOfDay: string;
  /** 0 = Sunday. Used by weekly. */
  dayOfWeek: number;
  /** 1–28. Capped at 28 so every month has the day. */
  dayOfMonth: number;
  /** Used by the interval frequency. */
  intervalHours: number;
  /** Refuse to send while any blocking validation finding remains. */
  requireValidation: boolean;
  /** Refuse to send until a person has approved the current data. Approval is
   * void as soon as the WHONET file changes. */
  requireValidatedSignOff: boolean;
  /** How long to wait before trying again after a failed automatic run. */
  retryMinutes: number;
}

export const DEFAULT_SCHEDULE: SyncSchedule = {
  mode: "manual",
  frequency: "weekly",
  timeOfDay: "18:00",
  dayOfWeek: 5,
  dayOfMonth: 1,
  intervalHours: 6,
  requireValidation: true,
  requireValidatedSignOff: true,
  retryMinutes: 30,
};

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function parseTimeOfDay(value: string): { hours: number; minutes: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  const hours = Math.min(23, Math.max(0, Number(match?.[1] ?? 18)));
  const minutes = Math.min(59, Math.max(0, Number(match?.[2] ?? 0)));
  return { hours, minutes };
}

/**
 * The next moment this schedule fires, counted from the last run.
 *
 * Local time throughout: a laboratory that asks for 18:00 means six in the
 * evening where it is, and a schedule that drifts with UTC is a schedule people
 * stop trusting.
 */
export function nextRunAt(
  schedule: SyncSchedule,
  lastRunAt: string | null,
  now: Date = new Date(),
): Date | null {
  if (schedule.mode !== "automatic") return null;

  const last = lastRunAt ? new Date(lastRunAt) : null;
  const { hours, minutes } = parseTimeOfDay(schedule.timeOfDay);

  if (schedule.frequency === "interval") {
    const step = Math.max(1, schedule.intervalHours) * 3_600_000;
    if (!last) return now;
    return new Date(last.getTime() + step);
  }

  if (schedule.frequency === "hourly") {
    if (!last) return now;
    return new Date(last.getTime() + 3_600_000);
  }

  // Calendar schedules are answered the same way whatever their period: find
  // the occurrence that has most recently passed, and the one still to come. If
  // the last run predates the one that passed, the schedule is overdue and that
  // moment is the answer — a laboratory whose computer was off at six o'clock
  // should upload when it comes back on, not silently skip the day.
  const previous = previousOccurrence(schedule, now, hours, minutes);
  if (previous && (!last || last.getTime() < previous.getTime())) return previous;
  return nextOccurrence(schedule, now, hours, minutes);
}

function previousOccurrence(
  schedule: SyncSchedule,
  now: Date,
  hours: number,
  minutes: number,
): Date | null {
  const candidate = new Date(now);
  candidate.setHours(hours, minutes, 0, 0);

  if (schedule.frequency === "daily") {
    if (candidate > now) candidate.setDate(candidate.getDate() - 1);
    return candidate;
  }

  if (schedule.frequency === "weekly") {
    const target = clampDay(schedule.dayOfWeek);
    let back = (candidate.getDay() - target + 7) % 7;
    if (back === 0 && candidate > now) back = 7;
    candidate.setDate(candidate.getDate() - back);
    return candidate;
  }

  const day = clampDate(schedule.dayOfMonth);
  candidate.setDate(day);
  if (candidate > now) candidate.setMonth(candidate.getMonth() - 1, day);
  return candidate;
}

function nextOccurrence(
  schedule: SyncSchedule,
  now: Date,
  hours: number,
  minutes: number,
): Date {
  const candidate = new Date(now);
  candidate.setHours(hours, minutes, 0, 0);

  if (schedule.frequency === "daily") {
    if (candidate <= now) candidate.setDate(candidate.getDate() + 1);
    return candidate;
  }

  if (schedule.frequency === "weekly") {
    const target = clampDay(schedule.dayOfWeek);
    let forward = (target - candidate.getDay() + 7) % 7;
    if (forward === 0 && candidate <= now) forward = 7;
    candidate.setDate(candidate.getDate() + forward);
    return candidate;
  }

  const day = clampDate(schedule.dayOfMonth);
  candidate.setDate(day);
  if (candidate <= now) candidate.setMonth(candidate.getMonth() + 1, day);
  return candidate;
}

function clampDay(value: number): number {
  return Math.min(6, Math.max(0, Math.round(value)));
}

function clampDate(value: number): number {
  return Math.min(28, Math.max(1, Math.round(value)));
}

export function isDue(
  schedule: SyncSchedule,
  lastRunAt: string | null,
  now: Date = new Date(),
): boolean {
  if (schedule.mode !== "automatic") return false;
  const next = nextRunAt(schedule, lastRunAt, now);
  return next !== null && next.getTime() <= now.getTime();
}

/** One sentence a facility can check at a glance, on the settings page and in
 * the status bar. A schedule nobody can read is a schedule nobody audits. */
export function describeSchedule(schedule: SyncSchedule): string {
  if (schedule.mode !== "automatic") return "Manual — nothing is sent until you send it.";

  const time = schedule.timeOfDay;
  switch (schedule.frequency) {
    case "hourly":
      return "Automatic — every hour.";
    case "interval":
      return `Automatic — every ${schedule.intervalHours} hour(s).`;
    case "daily":
      return `Automatic — every day at ${time}.`;
    case "weekly":
      return `Automatic — every ${DAY_NAMES[schedule.dayOfWeek] ?? "Friday"} at ${time}.`;
    case "monthly":
      return `Automatic — on day ${schedule.dayOfMonth} of each month at ${time}.`;
  }
}

/**
 * A person's sign-off on the data as it stands.
 *
 * The fingerprint is over the dataset, so the approval dies the moment WHONET
 * writes another result. That is deliberate and it is the whole safeguard: an
 * approval that survived the data changing would be an approval of something
 * nobody looked at.
 */
export interface ValidationApproval {
  fingerprint: string;
  approvedAt: string;
  approvedBy: string | null;
  recordCount: number;
  blockingAtApproval: number;
}

export function approvalIsCurrent(
  approval: ValidationApproval | null,
  fingerprint: string,
): boolean {
  return approval !== null && approval.fingerprint === fingerprint;
}

export interface UploadGate {
  allowed: boolean;
  /** Why not, in the words the interface shows. */
  reason: string | null;
  code:
    | "ok"
    | "not_signed_in"
    | "offline"
    | "setup_incomplete"
    | "blocking_findings"
    | "not_approved"
    | "nothing_to_send";
}

/** Everything that must be true before a batch may be sent, evaluated in one
 * place so the button, the scheduler and the API path cannot disagree. */
export function evaluateUploadGate(input: {
  signedIn: boolean;
  online: boolean;
  setupComplete: boolean;
  blockingFindings: number;
  recordsReady: number;
  requireValidation: boolean;
  requireSignOff: boolean;
  approvalCurrent: boolean;
}): UploadGate {
  if (!input.setupComplete) {
    return {
      allowed: false,
      code: "setup_incomplete",
      reason: "Finish setup — facility code, server address and WHONET file — before uploading.",
    };
  }
  if (!input.signedIn) {
    return { allowed: false, code: "not_signed_in", reason: "Sign in before sending." };
  }
  if (!input.online) {
    return {
      allowed: false,
      code: "offline",
      reason:
        "You are working offline. The batch is ready and will send once the connection returns.",
    };
  }
  if (input.recordsReady === 0) {
    return {
      allowed: false,
      code: "nothing_to_send",
      reason: "There is nothing new to send.",
    };
  }
  if (input.requireValidation && input.blockingFindings > 0) {
    return {
      allowed: false,
      code: "blocking_findings",
      reason: `${input.blockingFindings} record problem(s) must be fixed before uploading. Open Validation.`,
    };
  }
  if (input.requireSignOff && !input.approvalCurrent) {
    return {
      allowed: false,
      code: "not_approved",
      reason:
        "The data has changed since it was last approved. Review it in Validation and approve it for upload.",
    };
  }
  return { allowed: true, code: "ok", reason: null };
}
