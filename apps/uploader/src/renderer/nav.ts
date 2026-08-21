/**
 * What this account sees down the side, and why.
 *
 * The application does two different jobs for two different kinds of person,
 * and the navigation is where that has to be honest.
 *
 * A **laboratory** works on the file on this computer: the grid, the checks,
 * the corrections, the analysis, the upload. Those modules are about *this
 * machine's* data, so they appear when this machine has data — a WHONET file
 * configured — or when the account belongs to a facility.
 *
 * An **administrator** does the same duties here as in the browser console:
 * accounts, the network of regions and laboratories, the submission queues, the
 * audit trail. They are not facility users and are not asked to pretend to be
 * one; the laboratory modules simply are not their work.
 *
 * Every entry is gated on a permission the platform actually issues, read from
 * the session rather than inferred from the role name. That matters for one
 * specific reason: the role list is not closed. A permission moved between
 * roles on the server changes this menu on the next sign-in, with nothing here
 * to update — whereas a menu written as `if (role === "data_steward")` would go
 * quietly wrong.
 *
 * Hiding is a courtesy, never a control. Everything behind these entries is
 * refused at the API for an account that should not reach it, exactly as it is
 * for the browser.
 */

import type { Status } from "./api.js";

export type Permission =
  | "upload:submit"
  | "surveillance:view_own_facility"
  | "surveillance:view_regional"
  | "surveillance:view_cross_facility"
  | "batch:review"
  | "mapping:review"
  | "facility:enroll"
  | "block:manage"
  | "block:create"
  | "user:manage"
  | "user:manage_facility"
  | "audit:read"
  | "methodology:manage";

export interface NavItem {
  route: string;
  label: string;
  /** The single-glyph mark drawn beside the label. Deliberately abstract: a
   * pictogram of a laboratory means nothing at 18 pixels, whereas a consistent
   * set of simple shapes gives each module a position the eye learns. */
  icon: string;
  /** Shown when any of these is held. Absent means everyone. */
  needs?: Permission[];
  /** Shown only when this machine is set up as a laboratory workstation. */
  laboratory?: boolean;
}

export interface NavGroup {
  group: string;
  items: NavItem[];
}

export const NAV: NavGroup[] = [
  {
    group: "Laboratory",
    items: [
      { route: "dashboard", label: "Dashboard", icon: "grid", laboratory: true },
      { route: "database", label: "Isolates", icon: "rows", laboratory: true },
      { route: "validation", label: "Validation", icon: "check", laboratory: true },
      { route: "upload", label: "Submit", icon: "upload", laboratory: true },
    ],
  },
  {
    group: "Analysis",
    items: [
      { route: "antibiogram", label: "Antibiogram", icon: "matrix", laboratory: true },
      { route: "organisms", label: "Organisms", icon: "cell", laboratory: true },
      { route: "antibiotics", label: "Antimicrobials", icon: "flask", laboratory: true },
      { route: "specimens", label: "Specimens & sites", icon: "drop", laboratory: true },
      { route: "trends", label: "Trends", icon: "trend", laboratory: true },
    ],
  },
  {
    group: "Surveillance platform",
    items: [
      {
        route: "regional",
        label: "Regional picture",
        icon: "globe",
        needs: ["surveillance:view_regional", "surveillance:view_cross_facility"],
      },
      {
        route: "submissions",
        label: "Submissions",
        icon: "inbox",
        needs: ["batch:review", "mapping:review"],
      },
    ],
  },
  {
    group: "Administration",
    items: [
      { route: "accounts", label: "Accounts", icon: "people", needs: ["user:manage", "user:manage_facility"] },
      { route: "network", label: "Network", icon: "network", needs: ["facility:enroll", "block:manage"] },
      { route: "audit", label: "Audit trail", icon: "seal", needs: ["audit:read"] },
    ],
  },
  {
    group: "Reference",
    items: [
      // Its own module, not a settings panel: this is the table a laboratory
      // reads while it works, consulted far more often than it is configured.
      { route: "breakpoints", label: "Breakpoints", icon: "table" },
    ],
  },
  {
    group: "This computer",
    items: [
      { route: "history", label: "Upload history", icon: "clock", laboratory: true },
      { route: "settings", label: "Settings", icon: "sliders" },
    ],
  },
];

/**
 * Whether this installation is a laboratory workstation.
 *
 * True once a WHONET file has been chosen, and true for any account attached to
 * a facility even before that — a laboratory scientist signing in on a fresh
 * machine needs to *see* the modules in order to finish setting one up. A
 * national administrator on their own laptop sees neither, which is right:
 * there is no WHONET file on it and they are not the person who would load one.
 */
export function isLaboratoryWorkstation(status: Status): boolean {
  return status.setupComplete || status.session?.facilityId !== null;
}

export function visibleNav(status: Status): NavGroup[] {
  const held = new Set(status.session?.permissions ?? []);
  const laboratory = isLaboratoryWorkstation(status);

  return NAV.map((group) => ({
    group: group.group,
    items: group.items.filter((item) => {
      if (item.laboratory && !laboratory) return false;
      if (!item.needs) return true;
      return item.needs.some((permission) => held.has(permission));
    }),
  })).filter((group) => group.items.length > 0);
}

/** Where to land after signing in.
 *
 * Not always the dashboard. An administrator with no laboratory on this machine
 * would land on an empty screen telling them to choose a WHONET file, which is
 * not their job and not their machine's purpose. */
export function defaultRoute(status: Status): string {
  const groups = visibleNav(status);
  if (isLaboratoryWorkstation(status)) return "dashboard";
  return groups[0]?.items[0]?.route ?? "settings";
}

/**
 * The navigation marks.
 *
 * Inline paths on a 24-unit grid, stroked rather than filled so they hold their
 * weight beside text at any size and inherit the current colour in both
 * themes. Drawn here rather than pulled from an icon package: eleven shapes is
 * not worth a dependency on a laboratory workstation, and every dependency in
 * this application is one more thing to vouch for.
 */
export const ICONS: Record<string, string> = {
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  rows: "M3 6h18M3 12h18M3 18h18",
  check: "M4 12.5l5 5L20 6.5",
  upload: "M12 19V5M6 11l6-6 6 6M4 21h16",
  matrix: "M4 4h16v16H4zM4 9.5h16M4 15h16M9.5 4v16M15 4v16",
  cell: "M12 3a9 9 0 100 18 9 9 0 000-18zM8.5 10.5a1 1 0 100 .01M14 9a1 1 0 100 .01M12 15a1 1 0 100 .01",
  flask: "M9 3h6M10 3v6L5 19a1.5 1.5 0 001.3 2.2h11.4A1.5 1.5 0 0019 19l-5-10V3M7.5 14h9",
  drop: "M12 3s6 6.7 6 10.5a6 6 0 11-12 0C6 9.7 12 3 12 3z",
  trend: "M3 17l5.5-5.5 3.5 3.5L21 6M21 6h-5M21 6v5",
  globe: "M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z",
  inbox: "M3 13h5l1.5 3h5L16 13h5M5 5h14l2 8v6H3v-6z",
  people: "M8 11a3.2 3.2 0 100-6.4A3.2 3.2 0 008 11zM2.5 20c0-3 2.5-5 5.5-5s5.5 2 5.5 5M16 11.5a3 3 0 100-6M17 15.2c2.6.4 4.5 2.3 4.5 4.8",
  network: "M12 3v5M6.5 21v-4M17.5 21v-4M4 8h16v4H4zM6.5 12v5M17.5 12v5M12 12v5",
  seal: "M12 3l2.4 1.7 2.9-.3 1 2.8 2.4 1.7-1 2.8 1 2.8-2.4 1.7-1 2.8-2.9-.3L12 21l-2.4-1.7-2.9.3-1-2.8L3.3 15l1-2.8-1-2.8 2.4-1.7 1-2.8 2.9.3z",
  table: "M3 5h18v14H3zM3 10h18M9 10v9M15 10v9",
  clock: "M12 3a9 9 0 100 18 9 9 0 000-18zM12 7.5V12l3 2",
  sliders: "M4 7h9M17 7h3M4 17h3M11 17h9M15 4.5v5M7 14.5v5",
};
