/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Deliberately no `env:` block. Next's `env` config inlines values into the
  // bundle at build time — that is what it is for — so listing AMRSS_API_URL
  // there baked whatever was set during `next build` (in a container build,
  // nothing, hence the localhost fallback) into the image and made the runtime
  // variable inert. Every page then failed in production while working locally.
  //
  // The dashboard reads the API server-side only, so the value never needs to
  // reach the browser and can simply be read from the environment per request.

  experimental: {
    // How long the browser may reuse a page it has already rendered before
    // going back to the server for it. This is what makes moving between tabs
    // feel instant: the first visit to each page is a server round-trip, and
    // every visit within the next thirty seconds is served from the browser's
    // own cache with no network at all — which is also what lets link
    // prefetching actually pre-warm a tab before it is clicked.
    //
    // Next 15 sets this to zero for dynamic pages by default, so every
    // navigation re-fetched from the server — on a free-tier API that may be
    // waking, the worst possible default. Thirty seconds of staleness is
    // nothing here: the figures change only when a laboratory uploads, and the
    // freshness banner on every page states the real data date regardless of
    // when the page itself was rendered.
    staleTimes: {
      dynamic: 30,
      static: 180,
    },
  },
};

export default nextConfig;
