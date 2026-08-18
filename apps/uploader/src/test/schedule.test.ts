import assert from "node:assert/strict";
import { test } from "node:test";

import {
  approvalIsCurrent,
  DEFAULT_SCHEDULE,
  describeSchedule,
  evaluateUploadGate,
  isDue,
  nextRunAt,
  type SyncSchedule,
} from "../core/schedule";
import {
  apiUrlProblem,
  daysSince,
  looksLikeDashboardAddress,
  makeVerifier,
  noApiHereMessage,
  normaliseApiUrl,
  verifyPassword,
} from "../core/session";

function schedule(overrides: Partial<SyncSchedule>): SyncSchedule {
  return { ...DEFAULT_SCHEDULE, mode: "automatic", ...overrides };
}

test("a manual schedule never becomes due on its own", () => {
  const manual = { ...DEFAULT_SCHEDULE, mode: "manual" as const };
  assert.equal(nextRunAt(manual, null), null);
  assert.equal(isDue(manual, null), false);
  assert.match(describeSchedule(manual), /^Manual/);
});

test("a daily schedule is due once the hour passes, and not twice", () => {
  const daily = schedule({ frequency: "daily", timeOfDay: "18:00" });
  const evening = new Date(2026, 7, 17, 18, 30);

  // Never run before: the occurrence that has passed today is the answer.
  assert.equal(isDue(daily, null, evening), true);

  const justRan = new Date(2026, 7, 17, 18, 31).toISOString();
  assert.equal(isDue(daily, justRan, new Date(2026, 7, 17, 22, 0)), false);
  // …and it comes round again tomorrow.
  const next = nextRunAt(daily, justRan, new Date(2026, 7, 17, 22, 0))!;
  assert.equal(next.getDate(), 18);
  assert.equal(next.getHours(), 18);
});

test("a schedule missed while the computer was off runs when it comes back", () => {
  // The laboratory's machine was switched off at six on Friday. Skipping the
  // week silently is the failure mode this avoids.
  const weekly = schedule({ frequency: "weekly", dayOfWeek: 5, timeOfDay: "18:00" });
  const lastRun = new Date(2026, 7, 7, 18, 0).toISOString();
  const mondayMorning = new Date(2026, 7, 17, 8, 0);

  assert.equal(isDue(weekly, lastRun, mondayMorning), true);
});

test("an interval schedule counts from the last run", () => {
  const every6h = schedule({ frequency: "interval", intervalHours: 6 });
  const lastRun = new Date(2026, 7, 17, 6, 0).toISOString();

  assert.equal(isDue(every6h, lastRun, new Date(2026, 7, 17, 11, 0)), false);
  assert.equal(isDue(every6h, lastRun, new Date(2026, 7, 17, 12, 1)), true);
  assert.match(describeSchedule(every6h), /every 6 hour/);
});

test("a monthly schedule lands on the day the facility chose", () => {
  const monthly = schedule({ frequency: "monthly", dayOfMonth: 5, timeOfDay: "09:00" });
  const next = nextRunAt(monthly, new Date(2026, 7, 5, 9, 0).toISOString(), new Date(2026, 7, 17))!;

  assert.equal(next.getDate(), 5);
  assert.equal(next.getMonth(), 8);
});

test("the upload gate refuses for one reason at a time, in the order that helps", () => {
  const base = {
    signedIn: true,
    online: true,
    setupComplete: true,
    blockingFindings: 0,
    recordsReady: 12,
    requireValidation: true,
    requireSignOff: true,
    approvalCurrent: true,
  };

  assert.equal(evaluateUploadGate(base).allowed, true);
  assert.equal(evaluateUploadGate({ ...base, setupComplete: false }).code, "setup_incomplete");
  assert.equal(evaluateUploadGate({ ...base, signedIn: false }).code, "not_signed_in");
  assert.equal(evaluateUploadGate({ ...base, online: false }).code, "offline");
  assert.equal(evaluateUploadGate({ ...base, recordsReady: 0 }).code, "nothing_to_send");
  assert.equal(evaluateUploadGate({ ...base, blockingFindings: 3 }).code, "blocking_findings");
  assert.equal(evaluateUploadGate({ ...base, approvalCurrent: false }).code, "not_approved");

  // A facility that has turned the sign-off requirement off is not blocked by it.
  assert.equal(
    evaluateUploadGate({ ...base, approvalCurrent: false, requireSignOff: false }).allowed,
    true,
  );
});

test("an approval dies when the data underneath it changes", () => {
  const approval = {
    fingerprint: "abc123",
    approvedAt: new Date().toISOString(),
    approvedBy: "A. Scientist",
    recordCount: 12,
    blockingAtApproval: 0,
  };

  assert.equal(approvalIsCurrent(approval, "abc123"), true);
  assert.equal(approvalIsCurrent(approval, "def456"), false);
  assert.equal(approvalIsCurrent(null, "abc123"), false);
});

test("an unusable API address is named before anything is sent to it", () => {
  // The old default pointed at the developer's own machine; signing in against
  // it failed inside fetch and the button looked broken.
  assert.match(apiUrlProblem("http://localhost:8000") ?? "", /this computer/);
  assert.match(apiUrlProblem("") ?? "", /No API address/);
  assert.match(apiUrlProblem("amrss.example.org") ?? "", /not a web address/);
  assert.equal(apiUrlProblem("https://amrss-api.example.org"), null);
  assert.equal(normaliseApiUrl("https://amrss-api.example.org/"), "https://amrss-api.example.org");
});

test("the offline password check accepts the password the server accepted, and nothing else", () => {
  const { kdfSalt, verifier } = makeVerifier("correct horse battery staple");
  const record = {
    identifier: "lab@example.org",
    kdfSalt,
    verifier,
    profile: {
      email: "lab@example.org",
      username: null,
      fullName: "A. Scientist",
      role: "laboratory_staff",
      facilityId: null,
      regionalBlockId: null,
      permissions: [],
      mustChangePassword: false,
    },
    lastOnlineAt: new Date().toISOString(),
    apiUrl: "https://amrss-api.example.org",
  };

  assert.equal(verifyPassword("correct horse battery staple", record), true);
  assert.equal(verifyPassword("Correct horse battery staple", record), false);
  // The password itself is not recoverable from what is stored.
  assert.equal(JSON.stringify(record).includes("correct horse"), false);
});

test("offline sign-in is measured from the last time the server was reached", () => {
  const thirtyOneDaysAgo = new Date(Date.now() - 31 * 86_400_000).toISOString();
  assert.ok(daysSince(thirtyOneDaysAgo) > 30);
  assert.ok(daysSince(new Date().toISOString()) < 1);
});

test("the dashboard address is recognised, not answered with a bare 404", () => {
  // What a laboratory actually pastes: the address in the browser it uses every
  // day. Reporting "the server answered 404" sends them to check their
  // password; naming the mistake sends them to the one field that is wrong.
  const pasted = "https://amrss.vercel.app/console/signin";

  assert.equal(looksLikeDashboardAddress(pasted), true);
  assert.match(apiUrlProblem(pasted) ?? "", /dashboard/);
  assert.match(apiUrlProblem(pasted) ?? "", /AMRSS_API_URL/);
  assert.match(noApiHereMessage(pasted, 404), /dashboard/);

  // A real API address is not mistaken for one.
  assert.equal(looksLikeDashboardAddress("https://amrss-api.onrender.com"), false);
  assert.equal(apiUrlProblem("https://amrss-api.onrender.com"), null);
});

test("an address answering without an API is distinguished from a bad password", () => {
  const message = noApiHereMessage("https://example.org", 404);
  assert.match(message, /no AMRSS API there/);
  assert.doesNotMatch(message, /password/i);
});

test("the endpoint and the console path are trimmed back to the base", () => {
  // Both get pasted: one from the API docs, one from the browser's address bar.
  assert.equal(
    normaliseApiUrl("https://amrss-api.onrender.com/api/v1/auth/login"),
    "https://amrss-api.onrender.com",
  );
  assert.equal(
    normaliseApiUrl("https://amrss.vercel.app/console/signin"),
    "https://amrss.vercel.app",
  );
  // A deployment that genuinely serves the API under a prefix keeps it: silently
  // truncating that would break a working configuration.
  assert.equal(
    normaliseApiUrl("https://example.org/amrss/"),
    "https://example.org/amrss",
  );
});
