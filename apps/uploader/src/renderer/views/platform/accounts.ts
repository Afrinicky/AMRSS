/**
 * Account administration, on the desktop.
 *
 * The same console the browser shows, in the software the person is already
 * signed into. A facility administrator adding a colleague, a regional
 * administrator onboarding a laboratory's staff and a superadmin appointing a
 * successor are all doing it here, and what each of them can see and do is
 * decided by the platform rather than by this file: the list only contains
 * accounts the server chose to return, and every row carries its own
 * `editable` flag.
 *
 * Two things are given more room than a generic CRUD screen would give them,
 * because both are ways authority moves and neither should be a select box in a
 * row:
 *
 * - **Changing a role** is its own dialogue, with the role's meaning written
 *   out beside its name and a box for why. Promoting a regional administrator
 *   to superadmin hands one person authority over every region in the
 *   programme; it should take a moment and leave a sentence behind.
 * - **Setting a password** says plainly that whoever types it now knows it, and
 *   that the account will be made to change it. There is no email reset in this
 *   system, so this is the recovery path and it is a two-person one.
 */

import { api, type PlatformUser, type RoleOption, type UserOptions } from "../../api.js";
import type { ViewContext } from "../../app.js";
import {
  badge,
  button,
  el,
  empty,
  field,
  modal,
  notice,
  select,
  table,
  textInput,
  toast,
} from "../../ui.js";
import { relativeTime } from "../../ui.js";

/** Survives the redraw after every edit, so a filtered list does not jump back
 * to the top when somebody unlocks an account. */
let search = "";
let showInactive = false;

export async function renderAccounts(host: HTMLElement, context: ViewContext): Promise<void> {
  const redraw = (): void => void renderAccounts(host, context);

  host.replaceChildren(
    el("div", {
      className: "page-head",
      children: [
        el("div", {
          children: [
            el("h2", { text: "Accounts" }),
            el("p", { text: "Who can sign in, what they may do, and where their authority stops." }),
          ],
        }),
      ],
    }),
    el("div", { className: "loading", text: "Loading accounts…" }),
  );

  const [people, options] = await Promise.all([api.platformUsers(), api.platformUserOptions()]);

  if (!people.ok || !options.ok) {
    host.replaceChildren(
      head(null, redraw),
      notice("bad", people.ok ? options.message : people.message),
    );
    return;
  }

  const users = people.data ?? [];
  const scope = options.data!;
  host.replaceChildren(head(scope, redraw));

  const needle = search.trim().toLowerCase();
  const visible = users
    .filter((user) => showInactive || user.isActive)
    .filter(
      (user) =>
        !needle ||
        `${user.fullName} ${user.email} ${user.username ?? ""} ${user.role} ${user.facilityName ?? ""}`
          .toLowerCase()
          .includes(needle),
    );

  host.append(toolbar(users, visible.length, redraw));

  if (visible.length === 0) {
    host.append(
      empty(
        needle
          ? "No account matches that."
          : "No accounts are visible to you yet. Accounts you may administer appear here.",
      ),
    );
    return;
  }

  host.append(
    table<PlatformUser>(
      [
        {
          label: "Name",
          sticky: true,
          value: (user) =>
            el("div", {
              className: "cell-stack",
              children: [
                el("span", { className: "cell-title", text: user.fullName }),
                el("span", { className: "cell-sub", text: user.username ?? user.email }),
              ],
            }),
        },
        { label: "Role", value: (user) => roleName(scope.roles, user.role) },
        { label: "Attached to", value: (user) => user.facilityName ?? scopeLabel(scope, user) },
        {
          label: "State",
          value: (user) =>
            el("div", {
              className: "cell-badges",
              children: [
                user.isActive ? badge("ok", "active") : badge("bad", "inactive"),
                user.isLocked ? badge("warn", "locked") : null,
                user.mustChangePassword ? badge("warn", "must change password") : null,
              ].filter(Boolean) as Node[],
            }),
        },
        {
          label: "Last signed in",
          value: (user) => (user.lastLoginAt ? relativeTime(user.lastLoginAt) : "never"),
        },
        {
          label: "",
          value: (user) =>
            user.editable
              ? el("div", {
                  className: "row-actions",
                  children: [
                    button("Role…", () => openRoleChange(user, scope, redraw), "ghost", {
                      small: true,
                      title: `Change what ${user.fullName} may do`,
                    }),
                    button("Edit…", () => openEdit(user, redraw), "ghost", { small: true }),
                    button("Password…", () => openPasswordReset(user, redraw), "ghost", {
                      small: true,
                    }),
                    user.isLocked
                      ? button(
                          "Unlock",
                          async () => {
                            const result = await api.platformUnlockUser({ userId: user.id });
                            toast(result.message, result.ok ? "ok" : "bad");
                            redraw();
                          },
                          "ghost",
                          { small: true },
                        )
                      : null,
                  ].filter(Boolean) as Node[],
                })
              : el("span", {
                  className: "small muted",
                  text: "read-only",
                  title:
                    "This account is outside what your role may administer — another region, or "
                    + "an authority above your own.",
                }),
        },
      ],
      visible,
    ),
  );
}

function head(scope: UserOptions | null, redraw: () => void): HTMLElement {
  return el("div", {
    className: "page-head",
    children: [
      el("div", {
        children: [
          el("h2", { text: "Accounts" }),
          el("p", {
            text: scope
              ? `Signing in as a ${prettyRole(scope.grantingAs)}, you may create ${
                  scope.roles.length
                } of the platform's roles.`
              : "Who can sign in, what they may do, and where their authority stops.",
          }),
        ],
      }),
      el("div", {
        className: "page-actions",
        children: scope
          ? [button("Add an account", () => openCreate(scope, redraw), "primary")]
          : [],
      }),
    ],
  });
}

function toolbar(all: PlatformUser[], shown: number, redraw: () => void): HTMLElement {
  const find = textInput(search, {
    placeholder: "name, email, role or facility",
    onInput: (value) => {
      search = value;
    },
  });
  find.addEventListener("change", redraw);
  find.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Enter") redraw();
  });

  const inactive = all.filter((user) => !user.isActive).length;

  return el("div", {
    className: "list-toolbar",
    children: [
      el("div", {
        className: "small muted",
        text: `${shown} of ${all.length} account${all.length === 1 ? "" : "s"}`,
      }),
      el("div", { className: "topbar-spacer" }),
      inactive > 0
        ? button(
            showInactive ? `Hide ${inactive} deactivated` : `Show ${inactive} deactivated`,
            () => {
              showInactive = !showInactive;
              redraw();
            },
            "ghost",
            { small: true },
          )
        : null,
      el("div", { className: "field inline", children: [find] }),
    ].filter(Boolean) as Node[],
  });
}

function roleName(roles: RoleOption[], value: string): string {
  return roles.find((role) => role.value === value)?.label ?? prettyRole(value);
}

function prettyRole(value: string): string {
  return value.replaceAll("_", " ");
}

function scopeLabel(scope: UserOptions, user: PlatformUser): string {
  if (user.regionalBlockId) {
    return scope.blocks.find((block) => block.id === user.regionalBlockId)?.name ?? "a region";
  }
  // No facility and no block. For the national role that is the point; for
  // anything else it would be a configuration mistake, and saying so is more
  // use than an em dash.
  return user.role === "superadmin" ? "National — every region" : "unattached";
}

/* --- Creating an account -------------------------------------------------- */

function openCreate(scope: UserOptions, redraw: () => void): void {
  const state = { role: scope.roles[0]?.value ?? "", facilityId: "", blockId: "" };
  const inputs = {
    fullName: textInput("", { placeholder: "Ama Mensah" }),
    email: textInput("", { placeholder: "a.mensah@hospital.example", type: "email" }),
    username: textInput("", { placeholder: "a.mensah (optional)" }),
    password: textInput("", { type: "password", placeholder: "at least 12 characters" }),
  };

  const scopeHost = el("div");
  const roleNote = el("p", { className: "small muted" });

  const chosen = (): RoleOption | undefined =>
    scope.roles.find((role) => role.value === state.role);

  function drawScope(): void {
    const role = chosen();
    roleNote.textContent = role?.description ?? "";
    scopeHost.replaceChildren();
    if (!role) return;

    if (role.scope === "facility") {
      scopeHost.append(
        field(
          "Facility",
          select(
            [
              { value: "", label: "Choose a facility…" },
              ...scope.facilities.map((f) => ({ value: f.id, label: f.name })),
            ],
            state.facilityId,
            (value) => {
              state.facilityId = value;
            },
          ),
          "This role sees one laboratory's data and no other.",
        ),
      );
    } else if (role.scope === "block") {
      scopeHost.append(
        field(
          "Region",
          select(
            [
              { value: "", label: "Choose a region…" },
              ...scope.blocks.map((b) => ({ value: b.id, label: b.name })),
            ],
            state.blockId,
            (value) => {
              state.blockId = value;
            },
          ),
          "The account's authority stops at this region's boundary.",
        ),
      );
    } else {
      scopeHost.append(
        notice(
          "info",
          "This role is national. It needs no facility and no region, and it holds "
            + "authority over all of them.",
        ),
      );
    }
  }
  drawScope();

  const problems = el("div");

  const close = modal(
    "Add an account",
    el("div", {
      children: [
        el("div", {
          className: "inline-fields",
          children: [
            field("Full name", inputs.fullName),
            field("Email", inputs.email, "Also the sign-in name, unless a username is set."),
          ],
        }),
        el("div", {
          className: "inline-fields",
          children: [
            field("Username", inputs.username, "Optional. Shorter to type at a shared bench."),
            field(
              "Password",
              inputs.password,
              "You will know this password, so the account is made to change it at first sign-in.",
            ),
          ],
        }),
        field(
          "Role",
          select(
            scope.roles.map((role) => ({ value: role.value, label: role.label })),
            state.role,
            (value) => {
              state.role = value;
              drawScope();
            },
          ),
        ),
        roleNote,
        scopeHost,
        problems,
      ],
    }),
    [
      button("Cancel", () => close(), "ghost"),
      button(
        "Create",
        async () => {
          problems.replaceChildren();
          const result = await api.platformCreateUser({
            email: inputs.email.value.trim(),
            username: inputs.username.value.trim() || null,
            fullName: inputs.fullName.value.trim(),
            role: state.role,
            password: inputs.password.value,
            facilityId: state.facilityId || null,
            regionalBlockId: state.blockId || null,
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

/* --- Changing a role ------------------------------------------------------ */

/**
 * The one screen in this console that moves authority.
 *
 * Deliberately not a dropdown in the table row. Every role is listed with what
 * it actually means, the scope selector follows the choice, and a reason is
 * invited — it goes into the audit trail, where in a year's time it will be the
 * only thing that explains why somebody has the authority they have.
 */
function openRoleChange(user: PlatformUser, scope: UserOptions, redraw: () => void): void {
  const state = {
    role: user.role,
    facilityId: user.facilityId ?? "",
    blockId: user.regionalBlockId ?? "",
  };
  const reason = textInput("", { placeholder: "e.g. taking over the national programme office" });
  const scopeHost = el("div");
  const problems = el("div");

  const grantable = scope.roles.some((role) => role.value === user.role);

  function drawScope(): void {
    const role = scope.roles.find((option) => option.value === state.role);
    scopeHost.replaceChildren();
    if (!role) return;
    if (role.scope === "facility") {
      scopeHost.append(
        field(
          "Facility",
          select(
            [
              { value: "", label: "Choose a facility…" },
              ...scope.facilities.map((f) => ({ value: f.id, label: f.name })),
            ],
            state.facilityId,
            (value) => {
              state.facilityId = value;
            },
          ),
        ),
      );
    } else if (role.scope === "block") {
      scopeHost.append(
        field(
          "Region",
          select(
            [
              { value: "", label: "Choose a region…" },
              ...scope.blocks.map((b) => ({ value: b.id, label: b.name })),
            ],
            state.blockId,
            (value) => {
              state.blockId = value;
            },
          ),
        ),
      );
    } else {
      scopeHost.append(
        notice(
          "warn",
          "National authority: every region, every facility, every account, and the "
            + "breakpoint table the whole programme interprets against.",
        ),
      );
    }
  }

  const options = el("div", { className: "role-choices" });
  for (const role of scope.roles) {
    const active = role.value === state.role;
    const node = el("button", {
      className: `role-choice${active ? " active" : ""}`,
      onClick: () => {
        state.role = role.value;
        for (const child of Array.from(options.children)) child.classList.remove("active");
        node.classList.add("active");
        drawScope();
      },
      children: [
        el("div", {
          className: "role-choice-head",
          children: [
            el("span", { className: "role-choice-name", text: role.label }),
            role.value === user.role ? badge("", "current") : null,
          ].filter(Boolean) as Node[],
        }),
        el("p", { className: "role-choice-note", text: role.description }),
      ],
    });
    options.append(node);
  }
  drawScope();

  const close = modal(
    `Change what ${user.fullName} may do`,
    el("div", {
      children: [
        grantable
          ? null
          : notice(
              "warn",
              `${user.fullName} currently holds a role above your own, so this change will be `
                + "refused. Ask an administrator at that level.",
            ),
        options,
        scopeHost,
        field(
          "Why (optional)",
          reason,
          "Recorded in the audit trail. In a year this sentence is what explains the change.",
        ),
        problems,
      ].filter(Boolean) as Node[],
    }),
    [
      button("Cancel", () => close(), "ghost"),
      button(
        "Change the role",
        async () => {
          problems.replaceChildren();
          const result = await api.platformChangeRole({
            userId: user.id,
            role: state.role,
            facilityId: state.facilityId || null,
            regionalBlockId: state.blockId || null,
            reason: reason.value.trim(),
          });
          if (!result.ok) {
            problems.replaceChildren(notice("bad", result.message));
            return;
          }
          close();
          toast(`${user.fullName} is now a ${prettyRole(state.role)}.`, "ok");
          redraw();
        },
        "primary",
      ),
    ],
    { wide: true },
  );
}

/* --- Editing, passwords, removal ------------------------------------------ */

function openEdit(user: PlatformUser, redraw: () => void): void {
  const inputs = {
    fullName: textInput(user.fullName),
    email: textInput(user.email, { type: "email" }),
    username: textInput(user.username ?? "", { placeholder: "none — signs in by email" }),
  };
  const problems = el("div");

  const close = modal(
    user.fullName,
    el("div", {
      children: [
        field("Full name", inputs.fullName),
        field("Email", inputs.email),
        field("Username", inputs.username, "Clear this box to go back to signing in by email."),
        el("p", {
          className: "small muted",
          text: "The role is changed separately — it is a different kind of decision.",
        }),
        problems,
      ],
    }),
    [
      button("Cancel", () => close(), "ghost"),
      user.isActive
        ? button(
            "Deactivate",
            async () => {
              const result = await api.platformUpdateUser({
                userId: user.id,
                patch: { isActive: false },
              });
              if (!result.ok) {
                problems.replaceChildren(notice("bad", result.message));
                return;
              }
              close();
              toast(`${user.fullName} can no longer sign in.`, "ok");
              redraw();
            },
            "danger",
          )
        : button(
            "Reactivate",
            async () => {
              const result = await api.platformUpdateUser({
                userId: user.id,
                patch: { isActive: true },
              });
              if (!result.ok) {
                problems.replaceChildren(notice("bad", result.message));
                return;
              }
              close();
              toast(`${user.fullName} can sign in again.`, "ok");
              redraw();
            },
          ),
      button(
        "Save",
        async () => {
          problems.replaceChildren();
          const result = await api.platformUpdateUser({
            userId: user.id,
            patch: {
              fullName: inputs.fullName.value.trim(),
              email: inputs.email.value.trim(),
              username: inputs.username.value.trim(),
            },
          });
          if (!result.ok) {
            problems.replaceChildren(notice("bad", result.message));
            return;
          }
          close();
          toast("Account updated.", "ok");
          redraw();
        },
        "primary",
      ),
    ],
  );
}

function openPasswordReset(user: PlatformUser, redraw: () => void): void {
  const password = textInput("", { type: "password", placeholder: "at least 12 characters" });
  const problems = el("div");

  const close = modal(
    `Set a password for ${user.fullName}`,
    el("div", {
      children: [
        notice(
          "warn",
          "There is no email reset in this system, so this is the recovery path — and it is the "
            + "one action here that hands a live credential to a second person. Give it to them in "
            + "person; they will be made to change it at their next sign-in.",
        ),
        field("New password", password),
        problems,
      ],
    }),
    [
      button("Cancel", () => close(), "ghost"),
      button(
        "Set the password",
        async () => {
          problems.replaceChildren();
          const result = await api.platformResetPassword({
            userId: user.id,
            password: password.value,
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
