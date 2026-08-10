import { cookies } from "next/headers";

import { SESSION_COOKIE, apiUrl } from "@/lib/api";

/**
 * Streams a stored report through the dashboard rather than linking to the API.
 *
 * A direct link from the browser to the surveillance API cannot work: the
 * session token lives in an httpOnly cookie scoped to *this* origin, so the
 * browser would send no credentials and the download would 401. Proxying keeps
 * the token where it belongs — on the server, never in reach of client-side
 * JavaScript — and keeps the API off the public origin entirely.
 *
 * Nothing is cached. A report is an access-controlled document, and a cached
 * copy is one served to whoever asks next.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ reportId: string }> },
) {
  const { reportId } = await params;
  const format = new URL(request.url).searchParams.get("file_format") ?? "pdf";

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) {
    return new Response("Not authenticated", { status: 401 });
  }

  const upstream = await fetch(
    `${apiUrl()}/api/v1/reports/${encodeURIComponent(reportId)}/download` +
      `?file_format=${encodeURIComponent(format)}`,
    { headers: { authorization: `Bearer ${token}` }, cache: "no-store" },
  );

  if (!upstream.ok || !upstream.body) {
    // The API's own reason is passed through: "unknown report" and "this report
    // has no xlsx artefact" call for different responses from the reader.
    return new Response(await upstream.text().catch(() => "Download failed"), {
      status: upstream.status,
    });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type":
        upstream.headers.get("content-type") ?? "application/octet-stream",
      "content-disposition":
        upstream.headers.get("content-disposition") ?? "attachment",
      "cache-control": "no-store",
    },
  });
}
