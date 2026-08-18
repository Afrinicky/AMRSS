import { cookies } from "next/headers";

import { SESSION_COOKIE, apiUrl } from "@/lib/api";

/**
 * The breakpoint table in force, downloaded as the template CSV.
 *
 * A route handler rather than a link straight at the API, because the API needs
 * the bearer token and the browser only holds an httpOnly cookie: a plain link
 * would arrive unauthenticated. The response is passed through unchanged so the
 * file that reaches the person's disk is byte-for-byte the file the importer
 * reads — round-tripping is the whole point, and a reshaping step here would be
 * a second chance to transpose a threshold.
 */
export async function GET(): Promise<Response> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) {
    return new Response("Sign in to download the breakpoint table.", { status: 401 });
  }

  const upstream = await fetch(`${apiUrl()}/api/v1/breakpoints/export`, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  });

  if (!upstream.ok) {
    return new Response(
      upstream.status === 403
        ? "You do not have permission to export the breakpoint table."
        : "The breakpoint table could not be downloaded.",
      { status: upstream.status },
    );
  }

  return new Response(upstream.body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition":
        upstream.headers.get("content-disposition") ??
        'attachment; filename="amrss-breakpoints.csv"',
      "cache-control": "no-store",
    },
  });
}
