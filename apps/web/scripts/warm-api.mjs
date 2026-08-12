// Wake the surveillance API before the static build reads from it.
//
// The public pages are prerendered at build time, and each one fetches from the
// regional API. On the free tier that API sleeps after inactivity and takes the
// better part of a minute to cold-start — longer than the per-page build budget,
// so a build that started against a sleeping API would time out prerendering the
// first page and fail. Waking it once here, before `next build` runs, means all
// of the pages that follow prerender against a warm API and capture real data
// rather than the "being prepared" fallback.
//
// This never fails the build. If the API cannot be woken — it is genuinely down,
// or the URL is unset for a local build — we exit cleanly and let each page fall
// back on its own; ISR then heals those pages within a revalidation window once
// the API is reachable again. Warming is an optimisation, not a dependency.

const apiUrl = process.env.AMRSS_API_URL;

if (!apiUrl) {
  console.log("[warm-api] AMRSS_API_URL not set — skipping (local or preview build).");
  process.exit(0);
}

// A real endpoint, not just liveness: a 200 here proves the app is up AND its
// database is reachable, which is what the prerender actually needs. It is also
// small and cache-friendly, so warming with it is cheap.
const probe = `${apiUrl.replace(/\/$/, "")}/api/v1/public/reference`;

// Budget generously: a cold start can take most of a minute, and this runs once
// for the whole build, so waiting here is far cheaper than a failed build.
const deadline = Date.now() + 90_000;
const perRequestTimeoutMs = 20_000;
let attempt = 0;

console.log(`[warm-api] waking ${probe} …`);

while (Date.now() < deadline) {
  attempt += 1;
  try {
    const response = await fetch(probe, {
      signal: AbortSignal.timeout(perRequestTimeoutMs),
      headers: { "content-type": "application/json" },
    });
    if (response.ok) {
      console.log(`[warm-api] API awake after ${attempt} attempt(s). Building against live data.`);
      process.exit(0);
    }
    console.log(`[warm-api] attempt ${attempt}: HTTP ${response.status}, retrying…`);
  } catch (error) {
    console.log(`[warm-api] attempt ${attempt}: ${error?.message ?? error}, retrying…`);
  }
  await new Promise((resolve) => setTimeout(resolve, 4_000));
}

console.log("[warm-api] could not wake the API in time — building with fallbacks; ISR will heal.");
process.exit(0);
