/**
 * The application shell: sign-in, navigation, and the connection light.
 *
 * The shape is the shape of the rest of the software a laboratory uses — a
 * signed-in header, a module list down the side, one screen per task — rather
 * than a single page with everything on it. Uploading, checking data, looking
 * at an antibiogram, reviewing another laboratory's submission and appointing
 * an administrator are different jobs, done by different people, at different
 * times.
 *
 * Which of them appear is decided by `nav.ts` from the permissions the platform
 * issued this account, not by role names written into this file. An
 * administrator signing in on their own machine gets the consoles and none of
 * the laboratory modules; a scientist gets the laboratory and none of the
 * consoles; somebody who is both gets both.
 */

import { api, type Status } from "./api.js";
import { beep, button, el, icon, toast } from "./ui.js";
import { defaultRoute, ICONS, visibleNav } from "./nav.js";
import { openConnectionSettings, renderSignIn } from "./views/signin.js";
import { renderDashboard } from "./views/dashboard.js";
import { renderDatabase } from "./views/database.js";
import { renderValidation } from "./views/validation.js";
import { renderUpload } from "./views/upload.js";
import {
  renderAntibiogram,
  renderAntibiotics,
  renderOrganisms,
  renderSpecimens,
  renderTrends,
} from "./views/analysis.js";
import { renderBreakpoints } from "./views/breakpoints.js";
import { renderHistory } from "./views/history.js";
import { renderSettings } from "./views/settings.js";
import { renderAccounts } from "./views/platform/accounts.js";
import { renderNetwork } from "./views/platform/network.js";
import { renderSubmissions } from "./views/platform/submissions.js";
import { renderAudit } from "./views/platform/audit.js";
import { renderRegional } from "./views/platform/regional.js";

export interface ViewContext {
  status: Status;
  navigate: (route: string) => void;
  refresh: () => Promise<void>;
}

type View = (host: HTMLElement, context: ViewContext) => void | Promise<void>;

/** Route → screen. Kept apart from the navigation definition so that a route
 * reached some other way — a deep link from a notice, a redirect after setup —
 * still resolves even when the menu entry for it is hidden. */
const VIEWS: Record<string, View> = {
  dashboard: renderDashboard,
  database: renderDatabase,
  validation: renderValidation,
  upload: renderUpload,
  antibiogram: renderAntibiogram,
  organisms: renderOrganisms,
  antibiotics: renderAntibiotics,
  specimens: renderSpecimens,
  trends: renderTrends,
  regional: renderRegional,
  submissions: renderSubmissions,
  accounts: renderAccounts,
  network: renderNetwork,
  audit: renderAudit,
  breakpoints: renderBreakpoints,
  history: renderHistory,
  settings: renderSettings,
};

const root = document.getElementById("app")!;

let status: Status | null = null;
let route: string | null = null;
let offlineAlarm: number | null = null;
let lastConnectionState: boolean | null = null;
/** The last upload-gate verdict drawn on screen. A status tick that changes it
 * has changed what the current view says, so the view is redrawn rather than
 * left claiming the batch can be sent while the header says the line is down. */
let lastGateCode: string | null = null;

async function refresh(): Promise<void> {
  status = await api.status();
  lastGateCode = status.gate.code;
  render();
}

function navigate(next: string): void {
  route = next;
  render();
}

function context(): ViewContext {
  return { status: status!, navigate, refresh };
}

function render(): void {
  if (!status) return;
  root.replaceChildren();

  if (!status.session) {
    renderSignIn(root, async () => {
      await refresh();
      // A laboratory that has not chosen its WHONET file yet has one job, and
      // it is not looking at an empty dashboard. An administrator on a machine
      // that will never hold one is sent to their own work instead.
      if (status && !status.setupComplete && status.session?.facilityId) navigate("settings");
    });
    return;
  }

  if (route === null || !reachable(route)) route = defaultRoute(status);

  const shell = el("div", { className: "shell" });
  shell.append(topbar(), body());
  root.append(shell);
}

/** Whether a route is one this account can still get to. Guards the case where
 * somebody is looking at a console and their role changes underneath them. */
function reachable(candidate: string): boolean {
  if (!status) return false;
  if (!(candidate in VIEWS)) return false;
  return visibleNav(status).some((group) =>
    group.items.some((item) => item.route === candidate),
  );
}

/* --- Chrome --------------------------------------------------------------- */

function topbar(): HTMLElement {
  const state = status!;
  const online = state.connectivity.online && state.session?.mode === "online";

  const light = el("button", {
    className: `link-light ${online ? "online" : "offline"}`,
    title: online
      ? `${state.connectivity.detail}${
          state.connectivity.latencyMs ? ` (${state.connectivity.latencyMs} ms)` : ""
        }`
      : `${state.connectivity.detail} Working offline: everything on this computer still works, and uploads resume when the connection does.`,
    onClick: () => {
      void api.reload().then(refresh);
    },
    children: [
      el("span", { className: "dot" }),
      el("span", { text: online ? "Online" : "Offline" }),
    ],
  });

  const session = state.session!;
  const identity = el("div", {
    className: "identity",
    children: [
      el("div", {
        className: "identity-text",
        children: [
          el("div", { className: "name", text: session.fullName }),
          el("div", {
            className: "role",
            text:
              session.mode === "offline"
                ? `${session.roleLabel} · offline${
                    session.offlineDaysRemaining !== null
                      ? `, ${session.offlineDaysRemaining} day(s) left`
                      : ""
                  }`
                : session.roleLabel,
          }),
        ],
      }),
      el("div", { className: "avatar", text: initials(session.fullName) }),
    ],
  });

  return el("header", {
    className: "topbar",
    children: [
      el("div", {
        className: "brand",
        children: [
          el("div", {
            className: "wordmark",
            children: [
              document.createTextNode("AMR"),
              el("span", { className: "accent", text: "SS" }),
            ],
          }),
          el("div", { className: "brand-sub", text: whereAmI(state) }),
        ],
      }),
      el("div", { className: "topbar-spacer" }),
      light,
      button("Web console", openConsole, "ghost", { small: true }),
      button("Sign out", signOut, "ghost", { small: true }),
      identity,
    ],
  });
}

/**
 * The line under the wordmark.
 *
 * Says what this window is looking at, which differs by who is signed in. A
 * facility user's answer is their laboratory; a regional administrator's is
 * their region; the national authority's is the programme. Showing "No facility
 * configured" to a superadmin — as the header used to — describes a
 * misconfiguration that is not one.
 */
function whereAmI(state: Status): string {
  const session = state.session;
  if (session?.role === "superadmin") return "National programme";
  if (state.facility.code) {
    return `${state.facility.name ?? "Facility"} · ${state.facility.code}`;
  }
  if (session?.regionalBlockId) return "Regional programme";
  return "No facility configured";
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]![0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]![0] ?? "") : "";
  return `${first}${last}`.toUpperCase();
}

async function openConsole(): Promise<void> {
  const result = await api.openWebConsole();
  toast(result.message, result.ok ? "ok" : "warn");
}

async function signOut(): Promise<void> {
  status = await api.signOut();
  route = null;
  render();
}

function body(): HTMLElement {
  const state = status!;
  const sidebar = el("nav", { className: "sidebar" });

  for (const group of visibleNav(state)) {
    sidebar.append(el("div", { className: "group", text: group.group }));
    for (const item of group.items) {
      const node = el("button", {
        className: `nav-item ${route === item.route ? "active" : ""}`.trim(),
        onClick: () => navigate(item.route),
        children: [
          icon(ICONS[item.icon] ?? ICONS.grid!),
          el("span", { className: "nav-label", text: item.label }),
        ],
      });

      const blocking = state.workspace.validation?.blocking ?? 0;
      if (item.route === "validation" && blocking > 0) {
        node.append(el("span", { className: "badge bad", text: String(blocking) }));
      }
      if (item.route === "upload" && state.gate.allowed) {
        node.append(el("span", { className: "badge ok", text: "ready" }));
      }
      // With no table loaded every measurement reads as pending, and the
      // dashboard flag alone has not been enough to say where to go about it.
      if (item.route === "breakpoints" && !state.workspace.breakpoints.loaded) {
        node.append(el("span", { className: "badge warn", text: "none" }));
      }
      sidebar.append(node);
    }
  }

  sidebar.append(footer(state));

  const content = el("main", { className: "content" });
  const view = VIEWS[route ?? ""] ?? VIEWS.settings!;
  void view(content, context());

  return el("div", { className: "shell-body", children: [sidebar, content] });
}

/** The state of this machine, at the foot of the sidebar. Only meaningful where
 * there is a WHONET file to be in a state about. */
function footer(state: Status): HTMLElement {
  if (!state.workspace.loaded && !state.setupComplete) {
    return el("div", { className: "sidebar-foot" });
  }
  return el("div", {
    className: "sidebar-foot",
    children: [
      el("div", {
        className: "foot-line",
        text: state.workspace.loaded
          ? `${state.workspace.recordCount.toLocaleString()} isolates loaded`
          : "No WHONET file loaded",
      }),
      el("div", {
        className: "foot-line muted",
        text: state.realtime.enabled ? "Watching the WHONET file" : "Manual refresh only",
      }),
      el("div", { className: "foot-line muted", text: state.schedule.description }),
    ],
  });
}

/**
 * The offline alert.
 *
 * A red light is easy to miss on a busy bench, so being offline also makes a
 * sound at the interval the facility sets. It stops the moment the connection
 * returns, and it can be turned off in Settings for a laboratory where a
 * repeating tone would be intolerable — a shared bench, or a night shift.
 */
function updateOfflineAlarm(): void {
  const state = status;
  if (offlineAlarm !== null) {
    window.clearInterval(offlineAlarm);
    offlineAlarm = null;
  }
  if (!state?.session) return;
  const online = state.connectivity.online && state.session.mode === "online";
  if (online || !state.connectivitySettings.audibleAlert) return;

  beep();
  offlineAlarm = window.setInterval(
    () => beep(),
    Math.max(15, state.connectivitySettings.alertIntervalSeconds) * 1000,
  );
}

api.onStatus((next) => {
  const wasSignedIn = status?.session !== null && status?.session !== undefined;
  status = next;
  const online = next.connectivity.online && next.session?.mode === "online";

  if (next.session && lastConnectionState !== null && lastConnectionState !== online) {
    toast(
      online
        ? "Connection to the surveillance platform restored."
        : "Connection lost. You can keep working; uploads resume when the connection returns.",
      online ? "ok" : "warn",
    );
  }
  lastConnectionState = next.session ? online : null;
  updateOfflineAlarm();

  // Only redraw when something structural changed. Redrawing on every status
  // tick would reset a half-typed filter every thirty seconds; never redrawing
  // leaves a screen saying "ready to send" beside a header saying "offline".
  const gateChanged = lastGateCode !== null && lastGateCode !== next.gate.code;
  lastGateCode = next.gate.code;
  if (wasSignedIn !== (next.session !== null) || gateChanged) render();
  else if (next.session) refreshChrome();
});

function refreshChrome(): void {
  const shell = root.querySelector(".shell");
  const header = root.querySelector(".topbar");
  if (!shell || !header) return;
  shell.replaceChild(topbar(), header);
}

api.onData(({ trigger }) => {
  void api.status().then((next) => {
    status = next;
    if (trigger === "watcher") {
      toast("The WHONET file changed — data reloaded.", "ok");
      render();
    } else {
      refreshChrome();
    }
  });
});

api.onSchedule((event) => {
  toast(
    event.ran
      ? `Scheduled upload: ${event.reason ?? "completed"}`
      : `Scheduled upload held back: ${event.reason ?? "not ready"}`,
    event.ran ? "ok" : "warn",
  );
  void refresh();
});

// Help → Connection settings, from anywhere in the application.
api.onOpenConnectionSettings(() => {
  void openConnectionSettings(() => void refresh());
});

void refresh();
