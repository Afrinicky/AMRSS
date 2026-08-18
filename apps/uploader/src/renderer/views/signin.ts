/**
 * Sign-in.
 *
 * Two boxes: the username and password the person already has for AMRSS. That
 * is the whole screen, deliberately.
 *
 * An earlier version asked for the server address here as well, and a
 * laboratory scientist — who did not choose that address, cannot verify it, and
 * has a specimen waiting — pasted the address of the dashboard they open every
 * day and was told "the server answered 404". The address is not their
 * decision. It is set when the software is installed, and it lives behind
 * "Connection settings", which is written for whoever installs it.
 *
 * The other rule here: every failure says what to do next, in a sentence a
 * bench scientist can act on. The technical wording still exists — a 404 is
 * genuinely useful to the person who can fix it — but it is one click away
 * under "Details for IT support", not in the way.
 */

import { api } from "../api.js";
import { button, el, modal, notice, textInput, toast } from "../ui.js";

export function renderSignIn(host: HTMLElement, onSignedIn: () => Promise<void>): void {
  host.replaceChildren();

  const brand = el("aside", {
    className: "signin-brand",
    children: [
      el("div", {
        children: [
          el("h1", {
            children: [
              document.createTextNode("AMR"),
              el("span", { className: "accent", text: "SS" }),
            ],
          }),
          el("p", {
            text: "Antimicrobial Resistance Surveillance System — laboratory uploader",
          }),
          el("ul", {
            children: [
              el("li", {
                text: "Reads your WHONET database where it already sits, and follows it as you enter results.",
              }),
              el("li", {
                text: "Shows your own data as S, I and R — antibiogram, trends, sites of infection — before anything is sent.",
              }),
              el("li", {
                text: "Checks every record and holds back what is incomplete, so gaps are fixed here rather than argued about later.",
              }),
              el("li", {
                text: "Patient names and hospital numbers never leave this computer. Only de-identified surveillance records are transmitted.",
              }),
            ],
          }),
        ],
      }),
      el("p", {
        className: "small",
        text: "Access is limited to authorised institutional users. All sign-in attempts are recorded.",
      }),
    ],
  });

  const form = el("form");
  const feedback = el("div");

  const identifier = textInput(null, { placeholder: "e.g. your work email" });
  identifier.autocomplete = "username";
  identifier.autocapitalize = "none";
  identifier.spellcheck = false;

  const password = textInput(null, { type: "password" });
  password.autocomplete = "current-password";

  const submit = el("button", { className: "primary", text: "Sign in" });
  submit.type = "submit";
  submit.style.width = "100%";

  // Whether this computer has been set up at all. Asked once, on the way in,
  // so an unconfigured installation says so plainly instead of failing at the
  // first sign-in attempt.
  void api.status().then((status) => {
    if (!status.apiUrl) {
      feedback.replaceChildren(
        notice(
          "info",
          "This computer has not been connected to AMRSS yet. Your IT support can do it in one step — see Connection settings below.",
        ),
      );
    }
    identifier.focus();
  });

  form.append(
    el("h2", { text: "Sign in" }),
    el("p", {
      className: "muted small",
      text: "Use the same username and password as the AMRSS website.",
    }),
    el("div", {
      className: "field",
      children: [el("label", { text: "Username or email" }), identifier],
    }),
    el("div", {
      className: "field",
      children: [el("label", { text: "Password" }), password],
    }),
    submit,
    feedback,
    el("p", {
      className: "small muted",
      text: "No internet? Sign in as usual — your data, the checks and the analysis all work offline, and uploading resumes on its own when the connection returns.",
    }),
    el("div", {
      className: "signin-footer",
      children: [
        button("Connection settings", () => openConnectionSettings(), "ghost", {
          small: true,
          title: "For IT support — the address this computer sends data to",
        }),
      ],
    }),
  );

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    feedback.replaceChildren();

    if (!identifier.value.trim() || !password.value) {
      feedback.replaceChildren(notice("warn", "Enter your username and password."));
      return;
    }

    submit.disabled = true;
    submit.textContent = "Signing in…";

    const result = await api.signIn({
      identifier: identifier.value.trim(),
      password: password.value,
    });

    submit.disabled = false;
    submit.textContent = "Sign in";
    password.value = "";

    if (!result.ok) {
      feedback.replaceChildren(
        notice(result.code === "bad_credentials" ? "warn" : "bad", result.message),
      );
      if (result.detail) feedback.append(technicalDetail(result.detail));
      if (result.code === "no_api_url" || result.code === "no_api_here") {
        feedback.append(
          button("Open connection settings", () => openConnectionSettings(), "default", {
            small: true,
          }),
        );
      }
      return;
    }

    if (result.status.session?.mode === "offline") {
      feedback.replaceChildren(notice("warn", result.message));
      // Offline is a working state, not a failure: the person is signed in and
      // the shell should open, with the message carried across as a toast.
      window.setTimeout(() => void onSignedIn(), 1400);
      return;
    }

    await onSignedIn();
  });

  host.append(
    el("div", {
      className: "signin",
      children: [brand, el("div", { className: "signin-form", children: [form] })],
    }),
  );
}

/** The technical sentence, folded away. Present for the person who can act on
 * it, absent for the person who cannot. */
function technicalDetail(detail: string): HTMLElement {
  const block = document.createElement("details");
  block.className = "detail";
  const summary = document.createElement("summary");
  summary.textContent = "Details for IT support";
  block.append(summary, el("p", { className: "small muted", text: detail }));
  return block;
}

/**
 * Where the addresses live.
 *
 * Behind a click, labelled for the person it is meant for, and with a test
 * button — so whoever sets this up finds out here whether it works, rather than
 * a laboratory finding out at sign-in.
 */
export async function openConnectionSettings(onSaved?: () => void): Promise<void> {
  const status = await api.status();
  const body = el("div");

  const serviceAddress = textInput(status.apiUrl, {
    placeholder: "https://amrss-api.example.org",
  });
  const websiteAddress = textInput(status.webUrl, { placeholder: "https://amrss.example.org" });
  const result = el("div");

  body.append(
    el("p", {
      className: "small muted",
      text: "For IT support. Laboratory staff never need these — they are set once, when the software is installed on a computer, and stay set.",
    }),
    el("div", {
      className: "field",
      children: [
        el("label", { text: "AMRSS service address" }),
        serviceAddress,
        el("div", {
          className: "help",
          text: "Where surveillance data is submitted. This is the API service, not the website staff open in a browser; on the website's deployment it is the AMRSS_API_URL setting.",
        }),
      ],
    }),
    el("div", {
      className: "field",
      children: [
        el("label", { text: "AMRSS website address (optional)" }),
        websiteAddress,
        el("div", {
          className: "help",
          text: "Used by “Open the AMRSS website”, which signs the user in without a second password.",
        }),
      ],
    }),
    result,
  );

  const close = modal("Connection settings", body, [
    button("Test connection", async () => {
      result.replaceChildren(notice("info", "Testing…"));
      const test = await api.testConnection(serviceAddress.value.trim());
      result.replaceChildren(notice(test.ok ? "ok" : "bad", test.message));
      if (!test.ok && typeof test.detail === "string") {
        result.append(technicalDetail(test.detail));
      }
    }),
    button("Close", () => close()),
    button(
      "Save",
      async () => {
        await api.saveSettings({
          apiUrl: serviceAddress.value.trim(),
          webUrl: websiteAddress.value.trim(),
        });
        close();
        toast("Connection settings saved.");
        onSaved?.();
      },
      "primary",
    ),
  ]);
}
