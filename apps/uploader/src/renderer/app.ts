/**
 * The application shell: sign-in, navigation, and the connection light.
 *
 * The shape is deliberately the shape of the rest of the software a laboratory
 * uses — a signed-in header, a module list down the side, one screen per task —
 * rather than a single page with everything on it. Uploading, checking data,
 * looking at an antibiogram and configuring a schedule are different jobs, done
 * by different people, at different times.
 */

import { api, type Status } from "./api.js";
import { beep, button, el, toast } from "./ui.js";
import { renderSignIn } from "./views/signin.js";
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
import { renderHistory } from "./views/history.js";
import { renderSettings } from "./views/settings.js";

export interface ViewContext {
  status: Status;
  navigate: (route: string) => void;
  refresh: () => Promise<void>;
}

type View = (host: HTMLElement, context: ViewContext) => void | Promise<void>;

const NAV: Array<{ group: string; items: Array<{ route: string; label: string; view: View }> }> = [
  {
    group: "Surveillance",
    items: [
      { route: "dashboard", label: "Dashboard", view: renderDashboard },
      { route: "database", label: "Database", view: renderDatabase },
      { route: "validation", label: "Validation", view: renderValidation },
      { route: "upload", label: "Upload", view: renderUpload },
    ],
  },
  {
    group: "Analysis",
    items: [
      { route: "antibiogram", label: "Antibiogram", view: renderAntibiogram },
      { route: "organisms", label: "Organisms", view: renderOrganisms },
      { route: "antibiotics", label: "Antimicrobials", view: renderAntibiotics },
      { route: "specimens", label: "Specimens & sites", view: renderSpecimens },
      { route: "trends", label: "Trends", view: renderTrends },
    ],
  },
  {
    group: "Facility",
    items: [
      { route: "history", label: "Upload history", view: renderHistory },
      { route: "settings", label: "Settings", view: renderSettings },
    ],
  },
];

const root = document.getElementById("app")!;

let status: Status | null = null;
let route = "dashboard";
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
      // it is not looking at an empty dashboard.
      if (!status?.setupComplete) navigate("settings");
    });
    return;
  }

  const shell = el("div", { className: "shell" });
  shell.append(topbar(), body());
  root.append(shell);
}

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

  const identity = el("div", {
    className: "identity",
    children: [
      el("div", {
        children: [
          el("div", { className: "name", text: state.session!.fullName }),
          el("div", {
            className: "role",
            text:
              state.session!.mode === "offline"
                ? `${state.session!.roleLabel} · offline${
                    state.session!.offlineDaysRemaining !== null
                      ? `, ${state.session!.offlineDaysRemaining} day(s) left`
                      : ""
                  }`
                : state.session!.roleLabel,
          }),
        ],
      }),
      light,
    ],
  });

  return el("header", {
    className: "topbar",
    children: [
      el("div", {
        children: [
          el("div", {
            className: "wordmark",
            children: [
              document.createTextNode("AMR"),
              el("span", { className: "accent", text: "SS" }),
              document.createTextNode(" Uploader"),
            ],
          }),
          el("div", {
            className: "facility",
            text: state.facility.code
              ? `${state.facility.name ?? "Facility"} · ${state.facility.code}`
              : "No facility configured",
          }),
        ],
      }),
      el("div", { className: "topbar-spacer" }),
      button("Open web console", openConsole, "ghost", { small: true }),
      button("Sign out", signOut, "ghost", { small: true }),
      identity,
    ],
  });
}

async function openConsole(): Promise<void> {
  const result = await api.openWebConsole();
  toast(result.message, result.ok ? "ok" : "warn");
}

async function signOut(): Promise<void> {
  status = await api.signOut();
  render();
}

function body(): HTMLElement {
  const state = status!;
  const sidebar = el("nav", { className: "sidebar" });

  for (const group of NAV) {
    sidebar.append(el("div", { className: "group", text: group.group }));
    for (const item of group.items) {
      const node = el("button", {
        className: `nav-item ${route === item.route ? "active" : ""}`.trim(),
        onClick: () => navigate(item.route),
        children: [el("span", { text: item.label })],
      });

      const blocking = state.workspace.validation?.blocking ?? 0;
      if (item.route === "validation" && blocking > 0) {
        node.append(el("span", { className: "badge bad", text: String(blocking) }));
      }
      if (item.route === "upload" && state.gate.allowed) {
        node.append(el("span", { className: "badge ok", text: "ready" }));
      }
      sidebar.append(node);
    }
  }

  sidebar.append(
    el("div", { className: "group", text: "Data" }),
    el("div", {
      className: "small muted",
      children: [
        el("div", {
          text: state.workspace.loaded
            ? `${state.workspace.recordCount.toLocaleString()} isolates loaded`
            : "No WHONET file loaded",
        }),
        el("div", {
          text: state.realtime.enabled ? "Watching the WHONET file" : "Manual refresh only",
        }),
        el("div", { text: state.schedule.description }),
      ],
    }),
  );

  const content = el("main", { className: "content" });
  const view = NAV.flatMap((group) => group.items).find((item) => item.route === route);
  void (view ?? NAV[0]!.items[0]!).view(content, context());

  return el("div", { className: "shell-body", children: [sidebar, content] });
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

void refresh();
