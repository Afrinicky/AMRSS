/**
 * Sign-in.
 *
 * One account for both halves of AMRSS: the same username and password that
 * open the web console open this. Two things the previous version got wrong are
 * fixed here and are worth naming, because both produced a button that looked
 * broken.
 *
 * First, the server address is asked for *on this screen*. It used to live on a
 * settings panel further in, defaulted to a developer's localhost, and signing
 * in against it failed inside `fetch` with nothing shown. Now the address is
 * part of signing in, it is checked before anything is sent, and an address that
 * cannot work says so before the password is typed.
 *
 * Second, every failure has a distinct message. "Wrong password", "server not
 * responding", "account locked" and "no address configured" send a person to
 * four different actions, and collapsing them into "sign-in failed" sends
 * everyone to the wrong one.
 */

import { api } from "../api.js";
import { el, notice, textInput } from "../ui.js";

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

  const identifier = textInput(null, { placeholder: "username or email" });
  identifier.autocomplete = "username";
  identifier.autocapitalize = "none";
  identifier.spellcheck = false;

  const password = textInput(null, { type: "password" });
  password.autocomplete = "current-password";

  const apiUrl = textInput(null, { placeholder: "https://amrss-api.onrender.com" });
  const submit = el("button", { className: "primary", text: "Sign in" });
  submit.type = "submit";
  submit.style.width = "100%";

  void api.status().then((status) => {
    apiUrl.value = status.apiUrl ?? "";
    if (!status.apiUrl) {
      feedback.replaceChildren(
        notice(
          "info",
          "First run on this computer: enter the AMRSS server address your regional administrator gave you, then sign in with your platform account.",
        ),
      );
    }
    identifier.focus();
  });

  form.append(
    el("div", {
      className: "field",
      children: [el("label", { text: "Username or email" }), identifier],
    }),
    el("div", {
      className: "field",
      children: [el("label", { text: "Password" }), password],
    }),
    el("div", {
      className: "field",
      children: [
        el("label", { text: "AMRSS API address" }),
        apiUrl,
        el("div", {
          className: "help",
          text:
            "The API, not the dashboard you open in a browser — they are two different " +
            "addresses. Ask your regional Data Steward for it; saved after the first " +
            "successful sign-in.",
        }),
      ],
    }),
    submit,
    feedback,
    el("p", {
      className: "small muted",
      text: "No connection? Sign in with the account that last used this computer — your data, checks and analysis all work offline, and uploading resumes when the connection does.",
    }),
  );

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    feedback.replaceChildren();

    if (!identifier.value.trim() || !password.value) {
      feedback.replaceChildren(notice("warn", "Enter your username and password."));
      return;
    }

    const problem = await api.apiUrlProblem(apiUrl.value);
    if (problem && !(await hasOfflineFallback())) {
      feedback.replaceChildren(notice("bad", problem));
      return;
    }

    submit.disabled = true;
    submit.textContent = "Signing in…";

    const result = await api.signIn({
      identifier: identifier.value.trim(),
      password: password.value,
      apiUrl: apiUrl.value.trim(),
    });

    submit.disabled = false;
    submit.textContent = "Sign in";
    password.value = "";

    if (!result.ok) {
      feedback.replaceChildren(
        notice(result.code === "offline_no_cache" ? "warn" : "bad", result.message),
      );
      return;
    }

    if (result.status.session?.mode === "offline") {
      feedback.replaceChildren(notice("warn", result.message));
      // Offline is a working state, not a failure: the person is signed in and
      // the shell should open, with the message carried across as a toast.
      window.setTimeout(() => void onSignedIn(), 1200);
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

/** Whether an offline sign-in could still succeed, so a bad address does not
 * block the one person who is allowed to work without one. */
async function hasOfflineFallback(): Promise<boolean> {
  const status = await api.status();
  return status.uploadCount > 0 || status.setupComplete;
}
