/**
 * What this installation was pointed at, decided once by whoever installed it.
 *
 * A laboratory scientist should never be asked for a server address. They did
 * not choose it, cannot verify it, and being asked implies the software expects
 * them to know — which is how a person ends up pasting the address of the
 * dashboard they open every day and being told "the server answered 404".
 *
 * So the address is deployment configuration, not a question. It arrives one of
 * three ways, in this order:
 *
 * 1. **Baked into the installer.** The build writes `deployment.json` beside the
 *    application from the programme's own settings, so the software a facility
 *    installs already knows where to send data. This is the normal case.
 * 2. **Set by IT after installation**, in the same file, or through the
 *    connection panel the interface keeps behind a deliberate click.
 * 3. **Absent** — and then the sign-in screen says the computer has not been
 *    connected yet and to ask IT, rather than presenting an empty box.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface DeploymentDefaults {
  /** Where the surveillance service lives. */
  apiUrl: string;
  /** The dashboard, for "Open the AMRSS website". */
  webUrl: string;
  /** Pre-set for a facility whose installer was prepared for it. */
  facilityCode: string | null;
  facilityName: string | null;
  /** Who to contact when something is wrong — shown instead of a stack trace. */
  supportContact: string | null;
}

export const NO_DEPLOYMENT: DeploymentDefaults = {
  apiUrl: "",
  webUrl: "",
  facilityCode: null,
  facilityName: null,
  supportContact: null,
};

/** File name looked for beside the packaged application and in the project. */
export const DEPLOYMENT_FILE = "deployment.json";

/**
 * Read the deployment file from the first place that has one.
 *
 * Every candidate is a directory the installer or an administrator controls; the
 * file is small, optional, and read once at start-up. A malformed file is
 * ignored rather than fatal — an application that will not open because a
 * configuration file has a stray comma is useless to a laboratory.
 */
export function readDeploymentDefaults(directories: string[]): DeploymentDefaults {
  for (const directory of directories) {
    if (!directory) continue;
    const path = join(directory, DEPLOYMENT_FILE);
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DeploymentDefaults>;
      return {
        apiUrl: (parsed.apiUrl ?? "").trim(),
        webUrl: (parsed.webUrl ?? "").trim(),
        facilityCode: parsed.facilityCode?.trim() || null,
        facilityName: parsed.facilityName?.trim() || null,
        supportContact: parsed.supportContact?.trim() || null,
      };
    } catch {
      /* a damaged file is treated as absent, and the interface says so */
    }
  }
  return { ...NO_DEPLOYMENT };
}

/** Where the supplied breakpoint table sits, relative to the same directories.
 * Beside the application rather than inside the asar, so a facility can replace
 * it with its own edition without rebuilding anything. */
export const SUPPLIED_BREAKPOINTS = join("breakpoints", "clsi_m100_ed36.csv");

/**
 * The breakpoint table the installer was built with, if it has one.
 *
 * It is deliberately not loaded on first run. A table that appeared by itself is
 * a table nobody chose, and therefore a table nobody checked against the edition
 * their laboratory actually reports under — which is the one thing that must not
 * happen quietly. Settings offers it as a button, next to the other ways of
 * getting a table, and says which edition it is before it is loaded.
 */
export function suppliedBreakpointPath(directories: string[]): string | null {
  for (const directory of directories) {
    if (!directory) continue;
    const path = join(directory, SUPPLIED_BREAKPOINTS);
    if (existsSync(path)) return path;
  }
  return null;
}
