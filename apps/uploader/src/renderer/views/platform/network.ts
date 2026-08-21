/**
 * The surveillance network: regions, districts, and the laboratories in them.
 *
 * Three levels of one structure, so they are one screen rather than three. A
 * region without districts cannot enrol anybody; a district without facilities
 * contributes nothing; a facility's status decides whether its data reaches the
 * verified antibiogram at all. Seeing them apart is how a laboratory ends up
 * enrolled into a district nobody activated.
 *
 * Who sees what is the platform's decision and not this file's. A regional
 * administrator's request comes back holding its own region and no other, so
 * the screen it draws is its region — not a filtered view of the country with
 * the rest hidden behind a permission check in the renderer.
 *
 * The one control here that no other console has is the **breakpoint
 * override**. Breakpoints are national: one programme, one definition of
 * resistance, so that a susceptible result at one laboratory means what it
 * means at every other. A laboratory that genuinely needs to depart from the
 * national table — a method it does not cover, an agent added locally — gets a
 * documented exception, granted by name, with a reason attached. That is what
 * this grants, and only a superadmin sees it.
 */

import { api, type PlatformBlock, type PlatformDistrict, type PlatformFacility } from "../../api.js";
import type { ViewContext } from "../../app.js";
import {
  badge,
  button,
  card,
  el,
  empty,
  field,
  modal,
  notice,
  relativeTime,
  select,
  table,
  textInput,
  toast,
} from "../../ui.js";

let openRegion: string | null = null;

export async function renderNetwork(host: HTMLElement, context: ViewContext): Promise<void> {
  const redraw = (): void => void renderNetwork(host, context);
  const national = context.status.session?.role === "superadmin";

  host.replaceChildren(
    heading(national, redraw),
    el("div", { className: "loading", text: "Loading the network…" }),
  );

  const [blocks, districts, facilities] = await Promise.all([
    api.platformBlocks(),
    api.platformDistricts({}),
    api.platformFacilities({}),
  ]);

  host.replaceChildren(heading(national, redraw));

  if (!blocks.ok) {
    host.append(notice("bad", blocks.message));
    return;
  }

  const regions = blocks.data ?? [];
  if (regions.length === 0) {
    host.append(
      el("div", {
        className: "empty-panel",
        children: [
          el("h3", { text: national ? "No regions yet" : "You are not attached to a region" }),
          el("p", {
            text: national
              ? "A region is the unit everything else hangs from: districts belong to it, "
                + "facilities are enrolled into its districts, and its accounts are scoped to it. "
                + "Creating one is national authority, which you hold."
              : "Ask a superadmin to attach your account to a region. Until then there is "
                + "nothing here for you to administer.",
          }),
          national ? button("Create the first region", () => openBlockEditor(redraw), "primary") : null,
        ].filter(Boolean) as Node[],
      }),
    );
    return;
  }

  if (openRegion === null || !regions.some((region) => region.id === openRegion)) {
    openRegion = regions[0]!.id;
  }

  if (regions.length > 1) {
    host.append(
      el("div", {
        className: "region-switch",
        children: regions.map((region) =>
          el("button", {
            className: `region-chip${region.id === openRegion ? " active" : ""}`,
            onClick: () => {
              openRegion = region.id;
              redraw();
            },
            children: [
              el("span", { className: "region-chip-name", text: region.name }),
              el("span", {
                className: "region-chip-meta",
                text: `${region.facilityCount} ${region.facilityCount === 1 ? "facility" : "facilities"}`,
              }),
            ],
          }),
        ),
      }),
    );
  }

  const region = regions.find((item) => item.id === openRegion)!;
  const regionDistricts = (districts.data ?? []).filter(
    (district) => district.regionalBlockId === region.id,
  );
  const regionFacilities = (facilities.data ?? []).filter(
    (facility) => facility.regionalBlockId === region.id,
  );

  host.append(regionCard(region, regionDistricts, national, redraw));
  host.append(districtCard(region, regionDistricts, redraw));
  host.append(facilityCard(region, regionDistricts, regionFacilities, national, redraw));
}

function heading(national: boolean, redraw: () => void): HTMLElement {
  return el("div", {
    className: "page-head",
    children: [
      el("div", {
        children: [
          el("h2", { text: "Network" }),
          el("p", {
            text: national
              ? "Every region in the programme, and the laboratories inside them."
              : "Your region, its districts and the laboratories enrolled in them.",
          }),
        ],
      }),
      el("div", {
        className: "page-actions",
        children: national
          ? [
              button("Add a region", () => openBlockEditor(redraw), "primary", {
                title: "Only national authority can bring a new region into existence.",
              }),
            ]
          : [],
      }),
    ],
  });
}

function regionCard(
  region: PlatformBlock,
  districts: PlatformDistrict[],
  national: boolean,
  redraw: () => void,
): HTMLElement {
  return card(
    region.name,
    `${region.governingBody} · code ${region.code}`,
    el("div", {
      className: "stat-row",
      children: [
        statTile("Districts", String(districts.length)),
        statTile("Facilities", String(region.facilityCount)),
        statTile("Status", region.status),
        statTile(
          "WHONET standard",
          region.whonetConfigStandard ?? "not set",
          region.whonetConfigStandard
            ? null
            : "Uploads declaring a different version are flagged rather than refused.",
        ),
      ],
    }),
    national
      ? null
      : notice(
          "info",
          "Your authority runs to this region's boundary. Another region's facilities, "
            + "accounts and data are not reachable from this account — that is by design, not a "
            + "loading failure.",
        ),
  );
}

function statTile(label: string, value: string, hint?: string | null): HTMLElement {
  return el("div", {
    className: "stat",
    children: [
      el("div", { className: "label", text: label }),
      el("div", { className: value.length > 12 ? "value long" : "value", text: value }),
      hint ? el("div", { className: "hint", text: hint }) : null,
    ].filter(Boolean) as Node[],
  });
}

function districtCard(
  region: PlatformBlock,
  districts: PlatformDistrict[],
  redraw: () => void,
): HTMLElement {
  const name = textInput("", { placeholder: "district name" });
  const add = el("div", {
    className: "inline-add",
    children: [
      name,
      button(
        "Add district",
        async () => {
          if (!name.value.trim()) return;
          const result = await api.platformCreateDistrict({
            regionalBlockId: region.id,
            name: name.value.trim(),
          });
          toast(result.message, result.ok ? "ok" : "bad");
          if (result.ok) redraw();
        },
        "default",
        { small: true },
      ),
    ],
  });

  return card(
    "Districts",
    "Facilities are enrolled into a district, so a region with none cannot enrol anybody.",
    districts.length === 0
      ? empty("No districts yet. Add the first one below.")
      : el("div", {
          className: "chip-list",
          children: districts.map((district) =>
            el("span", {
              className: "chip",
              children: [
                el("span", { text: district.name }),
                el("span", {
                  className: "chip-count",
                  text: String(district.facilityCount),
                  title: `${district.facilityCount} facilities`,
                }),
              ],
            }),
          ),
        }),
    add,
  );
}

function facilityCard(
  region: PlatformBlock,
  districts: PlatformDistrict[],
  facilities: PlatformFacility[],
  national: boolean,
  redraw: () => void,
): HTMLElement {
  const body =
    facilities.length === 0
      ? empty("No laboratories are enrolled in this region yet.")
      : table<PlatformFacility>(
          [
            {
              label: "Laboratory",
              sticky: true,
              value: (facility) =>
                el("div", {
                  className: "cell-stack",
                  children: [
                    el("span", { className: "cell-title", text: facility.name }),
                    el("span", {
                      className: "cell-sub",
                      text: `${facility.code} · ${facility.districtName}`,
                    }),
                  ],
                }),
            },
            {
              label: "Status",
              value: (facility) =>
                badge(
                  facility.status === "active"
                    ? "ok"
                    : facility.status === "suspended" || facility.status === "retired"
                      ? "bad"
                      : "warn",
                  facility.status.replaceAll("_", " "),
                ),
            },
            {
              label: "Quality",
              value: (facility) =>
                el("div", {
                  className: "cell-badges",
                  children: [
                    badge(facility.qcStatus === "satisfactory" ? "ok" : "warn", `QC ${facility.qcStatus}`),
                    badge(
                      facility.eqaStatus === "satisfactory" ? "ok" : "warn",
                      `EQA ${facility.eqaStatus}`,
                    ),
                  ],
                }),
            },
            {
              label: "Last upload",
              value: (facility) =>
                facility.lastAcceptedUploadAt
                  ? relativeTime(facility.lastAcceptedUploadAt)
                  : "never",
            },
            {
              label: "Breakpoints",
              title:
                "Where this laboratory's thresholds come from. National unless a superadmin has "
                + "granted it an exception.",
              value: (facility) =>
                facility.breakpointOverrideGranted
                  ? el("span", {
                      className: "badge warn",
                      text: "local override",
                      title: facility.breakpointOverrideNote ?? "",
                    })
                  : el("span", { className: "small muted", text: "national" }),
            },
            {
              label: "",
              value: (facility) =>
                el("div", {
                  className: "row-actions",
                  children: [
                    facility.availableTransitions.length > 0
                      ? button(
                          "Status…",
                          () => openTransition(facility, redraw),
                          "ghost",
                          { small: true },
                        )
                      : null,
                    national
                      ? button(
                          facility.breakpointOverrideGranted ? "Withdraw override" : "Grant override…",
                          () => openOverride(facility, redraw),
                          "ghost",
                          { small: true },
                        )
                      : null,
                  ].filter(Boolean) as Node[],
                }),
            },
          ],
          facilities,
        );

  const heading = el("div", {
    className: "card-head",
    children: [
      el("div", {
        children: [
          el("h3", { text: "Laboratories" }),
          el("p", {
            className: "card-note",
            text: "A facility contributes nothing to the verified antibiogram until it is active "
              + "and its quality attestations are current.",
          }),
        ],
      }),
      districts.length > 0
        ? button("Enrol a laboratory", () => openEnrollment(districts, redraw), "default", {
            small: true,
          })
        : null,
    ].filter(Boolean) as Node[],
  });

  return el("section", { className: "card", children: [heading, body] });
}

/* --- Dialogues ------------------------------------------------------------ */

function openBlockEditor(redraw: () => void): void {
  const inputs = {
    code: textInput("", { placeholder: "e.g. GAR" }),
    name: textInput("", { placeholder: "e.g. Greater Accra Region" }),
    governingBody: textInput("", { placeholder: "e.g. Regional Health Directorate" }),
    standard: textInput("", { placeholder: "e.g. WHONET 2025" }),
    districts: textInput("", { placeholder: "one per line, or comma separated" }),
  };
  const problems = el("div");

  const close = modal(
    "Add a region",
    el("div", {
      children: [
        el("p", {
          className: "small muted",
          text: "A region is configuration, never a code change. Everything else hangs from it: "
            + "districts belong to a region, facilities to a district, and a regional "
            + "administrator's authority stops at its boundary.",
        }),
        el("div", {
          className: "inline-fields",
          children: [field("Code", inputs.code), field("Name", inputs.name)],
        }),
        field("Governing body", inputs.governingBody),
        field(
          "WHONET configuration standard",
          inputs.standard,
          "Optional. Uploads declaring a different version are flagged, not refused.",
        ),
        field(
          "Districts",
          inputs.districts,
          "Created alongside the region, so enrolment can begin immediately.",
        ),
        problems,
      ],
    }),
    [
      button("Cancel", () => close(), "ghost"),
      button(
        "Create the region",
        async () => {
          problems.replaceChildren();
          const districts = inputs.districts.value
            .split(/[\n,]/)
            .map((part) => part.trim())
            .filter(Boolean);
          const result = await api.platformCreateBlock({
            code: inputs.code.value.trim().toUpperCase(),
            name: inputs.name.value.trim(),
            governingBody: inputs.governingBody.value.trim(),
            whonetConfigStandard: inputs.standard.value.trim() || null,
            districts,
          });
          if (!result.ok) {
            problems.replaceChildren(notice("bad", result.message));
            return;
          }
          close();
          toast(result.message, "ok");
          redraw();
        },
        "primary",
      ),
    ],
    { wide: true },
  );
}

function openEnrollment(districts: PlatformDistrict[], redraw: () => void): void {
  const inputs = {
    code: textInput("", { placeholder: "e.g. KBTH-MICRO" }),
    name: textInput("", { placeholder: "e.g. Korle Bu Teaching Hospital" }),
    whonet: textInput("", { placeholder: "e.g. WHONET 2025" }),
  };
  let districtId = districts[0]?.id ?? "";
  const problems = el("div");

  const close = modal(
    "Enrol a laboratory",
    el("div", {
      children: [
        el("p", {
          className: "small muted",
          text: "It starts pending and contributes nothing until it is activated, which needs its "
            + "quality attestations in place.",
        }),
        el("div", {
          className: "inline-fields",
          children: [field("Facility code", inputs.code), field("Name", inputs.name)],
        }),
        field(
          "District",
          select(
            districts.map((district) => ({ value: district.id, label: district.name })),
            districtId,
            (value) => {
              districtId = value;
            },
          ),
        ),
        field("WHONET version", inputs.whonet, "Optional."),
        problems,
      ],
    }),
    [
      button("Cancel", () => close(), "ghost"),
      button(
        "Enrol",
        async () => {
          problems.replaceChildren();
          const result = await api.platformEnrollFacility({
            code: inputs.code.value.trim(),
            name: inputs.name.value.trim(),
            districtId,
            whonetConfigVersion: inputs.whonet.value.trim() || null,
          });
          if (!result.ok) {
            problems.replaceChildren(notice("bad", result.message));
            return;
          }
          close();
          toast(result.message, "ok");
          redraw();
        },
        "primary",
      ),
    ],
    { wide: true },
  );
}

function openTransition(facility: PlatformFacility, redraw: () => void): void {
  let target = facility.availableTransitions[0] ?? "";
  const reason = textInput("", { placeholder: "why this facility is changing status" });
  const problems = el("div");

  const close = modal(
    `${facility.name} — status`,
    el("div", {
      children: [
        facility.blockingActivation.length > 0
          ? notice(
              "warn",
              `Still outstanding before activation: ${facility.blockingActivation.join(", ")}.`,
            )
          : null,
        field(
          "Move to",
          select(
            facility.availableTransitions.map((value) => ({
              value,
              label: value.replaceAll("_", " "),
            })),
            target,
            (value) => {
              target = value;
            },
          ),
          "Only the moves the lifecycle allows from here are offered.",
        ),
        field(
          "Reason",
          reason,
          "Required. A status change nobody stated a reason for is unauditable, and suspension in "
            + "particular is a decision someone has to own.",
        ),
        problems,
      ].filter(Boolean) as Node[],
    }),
    [
      button("Cancel", () => close(), "ghost"),
      button(
        "Apply",
        async () => {
          problems.replaceChildren();
          const result = await api.platformTransitionFacility({
            facilityId: facility.id,
            target,
            reason: reason.value.trim(),
          });
          if (!result.ok) {
            problems.replaceChildren(notice("bad", result.message));
            return;
          }
          close();
          toast(result.message, "ok");
          redraw();
        },
        "primary",
      ),
    ],
  );
}

/**
 * Permit one laboratory to keep its own breakpoints.
 *
 * The dialogue says what is being given up, because it is easy to grant and
 * hard to notice afterwards: from here on, this laboratory's S/I/R is not
 * necessarily the programme's. A reason is required for granting and not for
 * withdrawing — the exception is what has to be justified, not its removal.
 */
function openOverride(facility: PlatformFacility, redraw: () => void): void {
  const granting = !facility.breakpointOverrideGranted;
  const reason = textInput("", {
    placeholder: "e.g. runs gradient strips for anaerobes, not in the national table",
  });
  const problems = el("div");

  const close = modal(
    granting
      ? `Let ${facility.name} keep its own breakpoints`
      : `Withdraw ${facility.name}'s override`,
    el("div", {
      children: granting
        ? [
            notice(
              "warn",
              "Breakpoints are national so that a susceptible result at one laboratory means what "
                + "it means at every other. Granting this exception means this laboratory's S, I "
                + "and R may differ from the rest of the programme's, and the regional antibiogram "
                + "will contain both.",
            ),
            el("p", {
              className: "small muted",
              text: "Grant it where the national table genuinely does not cover what the "
                + "laboratory runs — a method, or an agent it reports and the table does not.",
            }),
            field(
              "Reason",
              reason,
              "Required, and recorded against the facility with your name. It is what makes the "
                + "exception reviewable a year from now.",
            ),
            problems,
          ]
        : [
            el("p", {
              text: `${facility.name} currently holds an override`
                + (facility.breakpointOverrideNote ? `: “${facility.breakpointOverrideNote}”.` : "."),
            }),
            notice(
              "info",
              "Withdrawing stops further local editing and the facility falls back to the "
                + "national table at its next sync. Nothing it has already entered is deleted.",
            ),
            problems,
          ],
    }),
    [
      button("Cancel", () => close(), "ghost"),
      button(
        granting ? "Grant the override" : "Withdraw it",
        async () => {
          problems.replaceChildren();
          const result = await api.platformSetBreakpointOverride({
            facilityId: facility.id,
            granted: granting,
            reason: reason.value.trim(),
          });
          if (!result.ok) {
            problems.replaceChildren(notice("bad", result.message));
            return;
          }
          close();
          toast(result.message, "ok");
          redraw();
        },
        granting ? "primary" : "danger",
      ),
    ],
    { wide: true },
  );
}
